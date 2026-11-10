'use strict';
// ============================================================================
// API: route table + handlers. Plain objects, no web framework.
// Every important rule (auth, admin, bans, daily limit, invitation validity,
// resource scoring) is enforced here on the server — never only in the UI.
// ============================================================================
const db = require('./db');
const U = require('./util');
const ai = require('./ai');
const mail = require('./mail');
const fairness = require('./fairness');

const E = process.env;
const H = 3600e3;
const DEMO = E.DEMO !== '0';
const HOURS = +E.CASE_HOURS || 5;          // appearance deadline for a summons
const INVITE_H = +E.INVITE_HOURS || 48;    // secure invitation-token lifetime
const DAILY_CASE_LIMIT = 2;
const SESSION_TTL = 7 * 24 * H;
const BASE = () => E.BASE_URL || `http://localhost:${E.PORT || 3000}`;
const now = U.now;

// ---- sessions (in memory; survive for the process lifetime) -----------------
const sessions = new Map();
function newSession(u) {
  const t = U.token(24);
  sessions.set(t, { roll: u.roll, expires: now() + SESSION_TTL });
  return t;
}
function sessionUser(t) {
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expires < now()) { sessions.delete(t); return null; }
  return db.userByRoll(s.roll) || null;
}

// ---- helpers ---------------------------------------------------------------
const J = (c, who, text) => c.log.push({ who, text, t: now() });
const tr = (c) => c.log.map((l) => `${l.who}: ${l.text}`).join('\n');
const pubCase = (c) => ({ ...c, likes: Array.isArray(c.likes) ? c.likes.length : 0 });

function role(c, u, as) {
  if (!u) return null;
  if (c.type === 'resource') {
    if (c.owner.roll === u.roll) return 'owner';
    return c.claimants.some((x) => x.roll === u.roll) ? 'claimant' : null;
  }
  if (DEMO && as && (as === 'complainant' || as === 'accused')) return as;
  if (u.roll === c.complainant.roll) return 'complainant';
  if (c.accused.roll && u.roll === c.accused.roll) return 'accused';
  return null;
}

function effStatus(inv) {
  if (inv.status === 'pending' && now() > inv.expires) return 'expired';
  return inv.status;
}

// Auto-expire temp bans, close overdue hearings, expire invitations.
function sweep() {
  const d = db.getDB();
  let changed = false;
  for (const c of d.cases) {
    if (c.type === 'standard' && (c.status === 'waiting' || c.status === 'live') && c.deadline && now() > c.deadline) {
      c.status = c.status === 'waiting' ? 'defaulted' : 'decided';
      c.winner = c.status === 'defaulted' ? 'complainant' : 'accused';
      c.reason = c.status === 'defaulted' ? 'Accused did not appear within the deadline.' : 'Hearing was not completed in time; case dismissed.';
      changed = true;
    }
  }
  for (const inv of d.invitations) {
    if (inv.status === 'pending' && now() > inv.expires) { inv.status = 'expired'; changed = true; }
  }
  for (const u of d.students) {
    if (u.status === 'banned' && u.ban && u.ban.until && now() > u.ban.until) {
      u.status = 'active'; const was = u.ban; u.ban = null;
      d.moderation.push({ id: U.uid(), action: 'auto-unban', targetId: u.id, targetName: u.name, by: 'system', reason: `Temporary ban expired (${was.reason || 'no reason'})`, at: now() });
      changed = true;
    }
  }
  if (changed) db.save();
}

function banInfo(u) {
  if (u.status !== 'banned') return null;
  if (u.ban && u.ban.until && now() > u.ban.until) return null; // expired (sweep will clear)
  return { until: u.ban ? u.ban.until : null, reason: u.ban ? u.ban.reason : 'Banned by administrator' };
}

function filedToday(roll) {
  const key = U.dayKey();
  return db.getDB().cases.filter((c) => {
    const owner = c.type === 'resource' ? c.owner.roll : c.complainant.roll;
    return owner === roll && !c.seeded && U.dayKey(c.created) === key;
  }).length;
}

function findOrCreateResource(name) {
  const d = db.getDB();
  let r = d.resources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) { r = { id: U.uid(), name: String(name), allocations: [] }; d.resources.push(r); }
  return r;
}

async function createInvitation({ caseId, caseTitle, kind, targetRoll = null, email = null, claimantId = null, invitedBy }) {
  const raw = kind === 'external' ? U.token(24) : null;
  const inv = {
    id: U.uid(), caseId, kind, targetRoll, email: email ? U.normEmail(email) : null, claimantId,
    tokenHash: raw ? U.sha256(raw) : null, status: 'pending', invitedBy,
    created: now(), expires: now() + INVITE_H * H, acceptedBy: null,
  };
  db.getDB().invitations.push(inv);
  let mailResult = null;
  if (kind === 'external') {
    const link = `${BASE()}/?invite=${raw}`;
    mailResult = await mail.sendInvite({ to: email, caseTitle, inviter: invitedBy, link, hours: INVITE_H });
    mailResult.link = link; // returned to the filer only in DEMO/dry-run for convenience
  }
  return { inv, raw, mailResult };
}

async function verdict(c) {
  const r = await ai.ai(`Case: ${c.title} - ${c.details}\nTranscript:\n${tr(c)}\n\nDeliver the verdict. First line must be exactly WINNER: complainant OR WINNER: accused. Then 2 short sentences of reasoning.`);
  let w = null, reason;
  if (r) { const m = r.text.match(/WINNER:\s*(complainant|accused)/i); if (m) { w = m[1].toLowerCase(); reason = r.text.replace(/WINNER:.*\n?/i, '').trim(); } }
  if (!w) {
    const len = (x) => c.log.filter((l) => l.who === x).reduce((a, l) => a + l.text.length, 0);
    w = len('complainant') >= len('accused') ? 'complainant' : 'accused';
    reason = 'The court found the ' + w + ' more convincing on the arguments presented.';
  }
  c.status = 'decided'; c.winner = w; c.reason = reason;
  J(c, 'judge', `VERDICT: the ${w} wins. ${reason}`);
}

const findCase = (id) => db.getDB().cases.find((x) => x.id === id);

// ============================================================================
// HANDLERS — each returns [status, body]
// ============================================================================
const h = {};

h.register = async ({ b }) => {
  const name = String(b.name || '').trim();
  const roll = String(b.roll || '').trim();
  const email = U.normEmail(b.email);
  const phone = String(b.phone || '').trim();
  const password = String(b.password || '');
  if (name.length < 2 || name.length > 80) return [400, { error: 'Enter your full name (2–80 characters).' }];
  if (!/^[A-Za-z0-9-]{3,20}$/.test(roll)) return [400, { error: 'Enter a valid roll number (e.g. 21CS-014).' }];
  if (!U.isEmail(email)) return [400, { error: 'Enter a valid email address.' }];
  if (password.length < 6) return [400, { error: 'Password must be at least 6 characters.' }];
  if (db.userByEmail(email)) return [409, { error: 'This email is already registered. Try logging in.' }];
  if (db.userByRoll(roll)) return [409, { error: 'This roll number is already registered.' }];
  const u = {
    id: U.uid(), name, roll, phone, email, passwordHash: U.hashPassword(password),
    emailVerified: true, role: 'user', status: 'active', ban: null, created: now(),
  };
  db.getDB().students.push(u);
  db.save();
  const notice = await mail.sendAdminNotice(u); // auto-approved; notify admin
  return [200, { token: newSession(u), me: db.publicUser(u, true), adminNotified: !!notice.sent }];
};

h.login = async ({ b }) => {
  const email = U.normEmail(b.email);
  const password = String(b.password || '');
  const u = db.userByEmail(email);
  if (!u || !U.verifyPassword(password, u.passwordHash)) return [401, { error: 'Wrong email or password.' }];
  const bi = banInfo(u);
  if (bi) return [403, { error: 'Your account is banned.', banned: true, ...bi }];
  return [200, { token: newSession(u), me: db.publicUser(u, true) }];
};

h.logout = async ({ token }) => { sessions.delete(token); return [200, { ok: true }]; };
h.me = async ({ u }) => [200, { me: db.publicUser(u, true), banned: banInfo(u), filedToday: filedToday(u.roll), dailyLimit: DAILY_CASE_LIMIT, demo: DEMO }];

h.profile = async ({ b, u }) => {
  if (b.name !== undefined) { const n = String(b.name).trim(); if (n.length < 2 || n.length > 80) return [400, { error: 'Invalid name.' }]; u.name = n; }
  if (b.phone !== undefined) u.phone = String(b.phone).trim();
  db.save();
  return [200, { me: db.publicUser(u, true) }];
};

h.students = async ({ q, u }) => {
  const query = String(q.get('q') || '').toLowerCase();
  const list = db.getDB().students
    .filter((s) => s.role !== 'admin' && s.roll !== u.roll && s.status === 'active')
    .filter((s) => !query || s.name.toLowerCase().includes(query) || s.roll.toLowerCase().includes(query))
    .slice(0, 30)
    .map((s) => ({ name: s.name, roll: s.roll }));
  return [200, list];
};

h.feed = async () => { sweep(); return [200, [...db.getDB().cases].sort((a, b) => b.created - a.created).map(pubCase)]; };

h.mine = async ({ u }) => {
  sweep();
  const d = db.getDB();
  const cases = d.cases.filter((c) => role(c, u)).sort((a, b) => b.created - a.created).map(pubCase);
  const invitations = d.invitations
    .filter((i) => i.kind === 'registered' && i.targetRoll === u.roll && effStatus(i) === 'pending')
    .map((i) => ({ id: i.id, caseId: i.caseId, caseTitle: (findCase(i.caseId) || {}).title, invitedBy: i.invitedBy, expires: i.expires }));
  return [200, { cases, invitations, filedToday: filedToday(u.roll), dailyLimit: DAILY_CASE_LIMIT }];
};

h.courtrooms = async () => {
  sweep();
  const rooms = db.getDB().cases
    .filter((c) => ['waiting', 'live', 'collecting'].includes(c.status))
    .map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.status, created: c.created }));
  return [200, rooms];
};

// ---- standard case filing ---------------------------------------------------
h.fileCase = async ({ b, u }) => {
  if (filedToday(u.roll) >= DAILY_CASE_LIMIT) return [429, { error: `Daily limit reached: you can file at most ${DAILY_CASE_LIMIT} cases per day.` }];
  const title = String(b.title || '').trim().slice(0, 80);
  const details = String(b.details || '').trim().slice(0, 500);
  if (!title || !details) return [400, { error: 'Add a case title and describe what happened.' }];
  let accused, kind, targetRoll = null, email = null;
  if (b.accusedRoll) {
    const a = db.userByRoll(String(b.accusedRoll));
    if (!a || a.roll === u.roll) return [400, { error: 'Pick a valid accused student (not yourself).' }];
    accused = { name: a.name, roll: a.roll, email: a.email }; kind = 'registered'; targetRoll = a.roll;
  } else if (b.accusedEmail) {
    email = U.normEmail(b.accusedEmail);
    if (!U.isEmail(email)) return [400, { error: 'Enter a valid email for the external student.' }];
    if (email === u.email) return [400, { error: 'You cannot summon yourself.' }];
    const existing = db.userByEmail(email);
    if (existing) { accused = { name: existing.name, roll: existing.roll, email: existing.email }; kind = 'registered'; targetRoll = existing.roll; }
    else { accused = { name: 'Pending invitee', roll: null, email }; kind = 'external'; }
  } else return [400, { error: 'Choose a registered student or enter an external email.' }];

  const c = {
    id: U.uid(), type: 'standard', title, details,
    complainant: { name: u.name, roll: u.roll }, accused,
    status: 'waiting', created: now(), deadline: now() + HOURS * H, turn: 'complainant',
    log: [], likes: [], objections: 0,
  };
  J(c, 'judge', `Court is now in session for "${c.title}". ${c.complainant.name}, you may present your case.`);
  db.getDB().cases.push(c);
  const { mailResult } = await createInvitation({ caseId: c.id, caseTitle: c.title, kind, targetRoll, email, invitedBy: u.name });
  db.save();
  return [200, { id: c.id, kind, emailed: !!(mailResult && mailResult.sent), inviteLink: DEMO && mailResult ? mailResult.link : undefined, hours: HOURS }];
};

h.getCase = async ({ u, m }) => {
  sweep();
  const c = findCase(m[1]);
  if (!c) return [404, { error: 'No such case' }];
  const r = role(c, u);
  if (!r && !DEMO) return [403, { error: 'Not your case' }];
  if (c.type === 'standard' && r === 'accused' && c.status === 'waiting') {
    c.status = 'live'; J(c, 'judge', `${c.accused.name} has joined. Both parties are present. Complainant, the floor is yours.`); db.save();
  }
  return [200, { ...pubCase(c), you: r, demo: DEMO, now: now() }];
};

h.speak = async ({ b, u, m }) => {
  const c = findCase(m[1]);
  if (!c || c.type !== 'standard' || !['waiting', 'live'].includes(c.status)) return [400, { error: 'Case closed' }];
  const r = role(c, u, b.as);
  if (r !== c.turn) return [400, { error: 'Your mic is muted. Wait for the judge.' }];
  const text = String(b.text || '').trim().slice(0, 600);
  if (!text) return [400, { error: 'Say something' }];
  c.status = 'live'; J(c, r, text);
  const n = c.log.filter((l) => l.who !== 'judge').length;
  if (n >= 4) await verdict(c);
  else {
    c.turn = r === 'complainant' ? 'accused' : 'complainant';
    const a = await ai.ai(`Case: ${c.title} - ${c.details}\nTranscript:\n${tr(c)}\n\nRespond as judge to the last statement with one sharp question or remark, then invite the ${c.turn} to respond.`);
    J(c, 'judge', a ? a.text : ai.LOCAL[n % 3] + ` (${c.turn}, your turn.)`);
  }
  db.save();
  return [200, pubCase(c)];
};

h.objection = async ({ b, u, m }) => {
  const c = findCase(m[1]);
  if (!c || c.type !== 'standard' || c.status !== 'live') return [400, { error: 'No hearing in progress' }];
  const r = role(c, u, b.as);
  if (!r || r === c.turn) return [400, { error: 'You can only object while the other side speaks.' }];
  c.objections++; J(c, r, 'OBJECTION!');
  const a = await ai.ai(`The ${r} objected to the ${c.turn}'s last statement:\n"${(c.log.filter((l) => l.who === c.turn).pop() || {}).text}"\nRule SUSTAINED or OVERRULED in one witty sentence.`);
  J(c, 'judge', a ? a.text : (c.objections % 2 ? 'Sustained. The court will disregard that.' : 'Overruled. Proceed.'));
  db.save();
  return [200, pubCase(c)];
};

h.like = async ({ u, m }) => {
  const c = findCase(m[1]);
  if (!c) return [404, {}];
  const i = c.likes.indexOf(u.roll);
  i < 0 ? c.likes.push(u.roll) : c.likes.splice(i, 1);
  db.save();
  return [200, { likes: c.likes.length, liked: i < 0 }];
};

// ---- resource dispute (Card 10) --------------------------------------------
h.createResource = async ({ b, u }) => {
  if (filedToday(u.roll) >= DAILY_CASE_LIMIT) return [429, { error: `Daily limit reached: you can file at most ${DAILY_CASE_LIMIT} cases per day.` }];
  const title = String(b.title || '').trim().slice(0, 80);
  const resourceName = String((b.resource && b.resource.name) || b.resourceName || '').trim().slice(0, 80);
  if (!title || !resourceName) return [400, { error: 'Add a title and the resource in dispute.' }];
  const windowMinutes = Math.max(0, Math.min(1440, +((b.resource && b.resource.windowMinutes) || b.windowMinutes) || 0));
  const timeSharing = !!b.timeSharing && windowMinutes > 0;
  const incoming = Array.isArray(b.claimants) ? b.claimants.slice(0, 6) : [];
  if (incoming.length < 1) return [400, { error: 'Add at least one competing student besides yourself.' }];

  const claimants = [];
  const invites = [];
  // owner is always a claimant
  const ownerClaim = incoming.find((x) => x.roll === u.roll) || b.ownerClaim || {};
  claimants.push(makeClaimant({ name: u.name, roll: u.roll, email: u.email }, ownerClaim));
  for (const cl of incoming) {
    if (cl.roll === u.roll) continue;
    let identity;
    if (cl.roll) {
      const s = db.userByRoll(String(cl.roll));
      if (!s) { invites.push({ error: `Unknown roll ${cl.roll}` }); continue; }
      identity = { name: s.name, roll: s.roll, email: s.email };
    } else if (cl.email) {
      const email = U.normEmail(cl.email);
      if (!U.isEmail(email)) continue;
      const s = db.userByEmail(email);
      identity = s ? { name: s.name, roll: s.roll, email: s.email } : { name: cl.name || 'Pending invitee', roll: null, email };
    } else continue;
    claimants.push(makeClaimant(identity, cl));
  }
  if (claimants.length < 2) return [400, { error: 'A resource dispute needs at least two competing students.' }];

  const c = {
    id: U.uid(), type: 'resource', title,
    details: String(b.details || '').trim().slice(0, 500),
    resource: { name: resourceName, windowMinutes },
    timeSharing, owner: { name: u.name, roll: u.roll },
    claimants, status: 'collecting', created: now(), deadline: now() + HOURS * H,
    log: [], likes: [], objections: 0,
  };
  db.getDB().cases.push(c);
  // invitations for claimants who are not the owner
  const inviteResults = [];
  for (const cl of claimants) {
    if (cl.roll === u.roll) continue;
    const kind = cl.roll ? 'registered' : 'external';
    const res = await createInvitation({ caseId: c.id, caseTitle: c.title, kind, targetRoll: cl.roll, email: cl.email, claimantId: cl.id, invitedBy: u.name });
    inviteResults.push({ roll: cl.roll, email: cl.email, kind, emailed: !!(res.mailResult && res.mailResult.sent), link: DEMO && res.mailResult ? res.mailResult.link : undefined });
  }
  db.save();
  return [200, { id: c.id, invitations: inviteResults }];
};

function makeClaimant(identity, claim) {
  const submitted = claim && claim.urgency != null && claim.deadline != null;
  return {
    id: U.uid(), name: identity.name, roll: identity.roll, email: identity.email,
    resource: String((claim && claim.resource) || '').slice(0, 120),
    reason: String((claim && claim.reason) || '').slice(0, 300),
    deadline: submitted ? +claim.deadline : null,
    urgency: submitted ? U.clamp(Math.round(+claim.urgency), 1, 10) : null,
    submitted: !!submitted,
  };
}

h.claim = async ({ b, u, m }) => {
  const c = findCase(m[1]);
  if (!c || c.type !== 'resource' || c.status !== 'collecting') return [400, { error: 'This dispute is not collecting claims.' }];
  const cl = c.claimants.find((x) => x.roll === u.roll);
  if (!cl) return [403, { error: 'You are not a claimant in this dispute.' }];
  if (b.urgency == null || b.deadline == null) return [400, { error: 'Provide an urgency (1–10) and a deadline.' }];
  cl.resource = String(b.resource || cl.resource || c.resource.name).slice(0, 120);
  cl.reason = String(b.reason || '').slice(0, 300);
  cl.deadline = +b.deadline;
  cl.urgency = U.clamp(Math.round(+b.urgency), 1, 10);
  cl.submitted = true;
  db.save();
  return [200, pubCase(c)];
};

h.resolve = async ({ u, m }) => {
  const c = findCase(m[1]);
  if (!c || c.type !== 'resource') return [404, { error: 'No such resource dispute.' }];
  if (c.owner.roll !== u.roll && u.role !== 'admin') return [403, { error: 'Only the filer or an admin can deliver the allocation.' }];
  if (c.status === 'decided') return [200, pubCase(c)];
  const submitted = c.claimants.filter((x) => x.submitted);
  if (submitted.length < 2) return [400, { error: 'At least two students must submit their needs before scoring.' }];
  const resource = findOrCreateResource(c.resource.name);
  const result = fairness.computeAllocation({
    resource: c.resource.name, claimants: submitted, history: resource.allocations,
    nowTs: now(), timeSharing: c.timeSharing, windowMinutes: c.resource.windowMinutes,
  });
  // Optional AI commentary — clearly labelled and NEVER affects the scores.
  let aiNote = null;
  if (ai.hasKeys()) {
    const r = await ai.ai(`A fair-resource allocation was already decided by a fixed formula. Table: ${result.table.map((t) => `${t.name}: total ${t.total}`).join('; ')}. Decision: ${result.explanation} In 2 sentences, explain this kindly to students. Do NOT change the decision.`, 'You are a helpful, neutral court clerk. You only explain a decision that is already final.');
    if (r) aiNote = { text: r.text, src: r.src, advisory: true };
  }
  result.aiNote = aiNote;
  c.allocation = result;
  c.status = 'decided';
  resource.allocations.push(...fairness.historyRecords(result, c.id, c.resource.name));
  db.save();
  return [200, pubCase(c)];
};

// add claimants to an existing resource dispute
h.inviteToCase = async ({ b, u, m }) => {
  const c = findCase(m[1]);
  if (!c) return [404, { error: 'No such case' }];
  if (c.type !== 'resource') return [400, { error: 'For standard cases the accused is named when filing.' }];
  if (c.owner.roll !== u.roll) return [403, { error: 'Only the filer can invite claimants.' }];
  if (c.status !== 'collecting') return [400, { error: 'This dispute is already decided.' }];
  let identity, kind;
  if (b.roll) { const s = db.userByRoll(String(b.roll)); if (!s) return [400, { error: 'Unknown student.' }]; if (c.claimants.some((x) => x.roll === s.roll)) return [400, { error: 'Already a claimant.' }]; identity = { name: s.name, roll: s.roll, email: s.email }; kind = 'registered'; }
  else if (b.email) { const email = U.normEmail(b.email); if (!U.isEmail(email)) return [400, { error: 'Invalid email.' }]; if (c.claimants.some((x) => x.email === email)) return [400, { error: 'Already invited.' }]; const s = db.userByEmail(email); identity = s ? { name: s.name, roll: s.roll, email: s.email } : { name: 'Pending invitee', roll: null, email }; kind = s ? 'registered' : 'external'; }
  else return [400, { error: 'Provide a roll or email.' }];
  const cl = makeClaimant(identity, {});
  c.claimants.push(cl);
  const res = await createInvitation({ caseId: c.id, caseTitle: c.title, kind, targetRoll: identity.roll, email: identity.email, claimantId: cl.id, invitedBy: u.name });
  db.save();
  return [200, { claimant: cl, emailed: !!(res.mailResult && res.mailResult.sent), link: DEMO && res.mailResult ? res.mailResult.link : undefined }];
};

// ---- invitations ------------------------------------------------------------
h.invitePreview = async ({ m }) => {
  const inv = db.getDB().invitations.find((i) => i.tokenHash && i.tokenHash === U.sha256(m[1]));
  if (!inv) return [404, { error: 'Invalid invitation link.' }];
  const c = findCase(inv.caseId);
  return [200, { id: inv.id, kind: inv.kind, status: effStatus(inv), expires: inv.expires, email: inv.email, caseTitle: c ? c.title : null, caseType: c ? c.type : null, inviter: inv.invitedBy }];
};

h.acceptInvite = async ({ b, u }) => {
  const d = db.getDB();
  let inv = null;
  if (b.token) inv = d.invitations.find((i) => i.tokenHash && i.tokenHash === U.sha256(String(b.token)));
  else if (b.id) inv = d.invitations.find((i) => i.id === String(b.id));
  if (!inv) return [404, { error: 'Invitation not found.' }];
  if (effStatus(inv) === 'expired') return [400, { error: 'This invitation has expired.' }];
  if (inv.status !== 'pending') return [400, { error: 'This invitation was already used or revoked.' }];
  if (inv.kind === 'registered' && inv.targetRoll !== u.roll) return [403, { error: 'This invitation is for another student.' }];
  const c = findCase(inv.caseId);
  if (!c) return [404, { error: 'The case no longer exists.' }];
  if (c.type === 'standard') {
    c.accused = { name: u.name, roll: u.roll, email: u.email };
    if (c.status === 'waiting') { c.status = 'live'; J(c, 'judge', `${u.name} has joined. Both parties are present. Complainant, the floor is yours.`); }
  } else if (c.type === 'resource') {
    const cl = c.claimants.find((x) => x.id === inv.claimantId);
    if (cl) { cl.roll = u.roll; cl.name = u.name; cl.email = u.email; }
  }
  inv.status = 'accepted'; inv.acceptedBy = u.roll;
  db.save();
  return [200, { caseId: c.id, joined: true, type: c.type }];
};

// ---- admin ------------------------------------------------------------------
function mod(action, actor, target, reason, meta) {
  db.getDB().moderation.push({ id: U.uid(), action, targetId: target ? target.id : null, targetName: target ? target.name : null, by: actor.name, reason: reason || '', at: now(), meta: meta || null });
}

h.adminUsers = async () => [200, db.getDB().students.map((s) => db.publicUser(s, true))];
h.adminCases = async () => [200, [...db.getDB().cases].sort((a, b) => b.created - a.created).map(pubCase)];
h.adminInvitations = async () => [200, db.getDB().invitations.map((i) => ({ ...i, tokenHash: undefined, status: effStatus(i), caseTitle: (findCase(i.caseId) || {}).title }))];
h.adminModeration = async () => [200, [...db.getDB().moderation].sort((a, b) => b.at - a.at)];
h.adminStats = async () => {
  const d = db.getDB();
  return [200, {
    users: d.students.length, banned: d.students.filter((s) => s.status === 'banned').length,
    cases: d.cases.length, live: d.cases.filter((c) => c.status === 'live' || c.status === 'waiting').length,
    resourceDisputes: d.cases.filter((c) => c.type === 'resource').length,
    invitations: d.invitations.length, pendingInvites: d.invitations.filter((i) => effStatus(i) === 'pending').length,
  }];
};

h.adminBan = async ({ b, u, m }) => {
  const target = db.userById(m[1]);
  if (!target) return [404, { error: 'No such user.' }];
  if (target.role === 'admin') return [400, { error: 'Administrators cannot be banned.' }];
  const hours = b.hours != null ? +b.hours : null;
  const reason = String(b.reason || '').trim().slice(0, 200) || 'No reason provided';
  const until = hours && hours > 0 ? now() + hours * H : null;
  target.status = 'banned'; target.ban = { until, reason, by: u.name, at: now() };
  mod(hours ? 'temp-ban' : 'ban', u, target, reason, { hours: hours || null, until });
  db.save();
  return [200, { user: db.publicUser(target, true) }];
};

h.adminUnban = async ({ u, m }) => {
  const target = db.userById(m[1]);
  if (!target) return [404, { error: 'No such user.' }];
  target.status = 'active'; target.ban = null;
  mod('unban', u, target, 'Ban lifted');
  db.save();
  return [200, { user: db.publicUser(target, true) }];
};

h.health = async () => [200, { ok: true, gemini: ai.keys('GEMINI_KEYS').length, groq: ai.keys('GROQ_KEYS').length, mail: mail.enabled(), demo: DEMO, schema: db.getDB().schemaVersion }];

// ============================================================================
// ROUTE TABLE
// ============================================================================
const routes = [
  ['POST', /^\/api\/register$/, h.register, {}],
  ['POST', /^\/api\/login$/, h.login, {}],
  ['GET', /^\/api\/health$/, h.health, {}],
  ['GET', /^\/api\/invitations\/([a-f0-9]+)\/preview$/, h.invitePreview, {}],

  ['POST', /^\/api\/logout$/, h.logout, { auth: true, allowBanned: true }],
  ['GET', /^\/api\/me$/, h.me, { auth: true, allowBanned: true }],
  ['POST', /^\/api\/profile$/, h.profile, { auth: true }],
  ['GET', /^\/api\/students$/, h.students, { auth: true }],
  ['GET', /^\/api\/feed$/, h.feed, { auth: true }],
  ['GET', /^\/api\/mine$/, h.mine, { auth: true }],
  ['GET', /^\/api\/courtrooms$/, h.courtrooms, { auth: true }],
  ['POST', /^\/api\/cases$/, h.fileCase, { auth: true }],
  ['POST', /^\/api\/resource$/, h.createResource, { auth: true }],
  ['GET', /^\/api\/cases\/([a-f0-9]+)$/, h.getCase, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/speak$/, h.speak, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/objection$/, h.objection, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/like$/, h.like, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/claim$/, h.claim, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/resolve$/, h.resolve, { auth: true }],
  ['POST', /^\/api\/cases\/([a-f0-9]+)\/invite$/, h.inviteToCase, { auth: true }],
  ['POST', /^\/api\/invitations\/accept$/, h.acceptInvite, { auth: true }],

  ['GET', /^\/api\/admin\/users$/, h.adminUsers, { auth: true, admin: true }],
  ['GET', /^\/api\/admin\/cases$/, h.adminCases, { auth: true, admin: true }],
  ['GET', /^\/api\/admin\/invitations$/, h.adminInvitations, { auth: true, admin: true }],
  ['GET', /^\/api\/admin\/moderation$/, h.adminModeration, { auth: true, admin: true }],
  ['GET', /^\/api\/admin\/stats$/, h.adminStats, { auth: true, admin: true }],
  ['POST', /^\/api\/admin\/users\/([a-f0-9]+)\/ban$/, h.adminBan, { auth: true, admin: true }],
  ['POST', /^\/api\/admin\/users\/([a-f0-9]+)\/unban$/, h.adminUnban, { auth: true, admin: true }],
];

// Dispatch a parsed request. Returns [status, body].
async function handle({ method, pathname, query, body, token }) {
  for (const [mth, re, fn, opts] of routes) {
    if (mth !== method) continue;
    const mm = pathname.match(re);
    if (!mm) continue;
    const u = sessionUser(token);
    if (opts.auth && !u) return [401, { error: 'Please log in.' }];
    if (opts.auth && u && !opts.allowBanned) {
      const bi = banInfo(u);
      if (bi) return [403, { error: 'Your account is banned.', banned: true, ...bi }];
    }
    if (opts.admin && (!u || u.role !== 'admin')) return [403, { error: 'Administrators only.' }];
    return await fn({ q: query, b: body || {}, u, m: mm, token });
  }
  return [404, { error: 'Not found' }];
}

module.exports = { handle, sessions, sweep };