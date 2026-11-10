'use strict';
// JSON-file database (same approach as the original project) with atomic writes
// and a forward migration that PRESERVES existing students and cases.
const fs = require('fs');
const path = require('path');
const { now, uid, hashPassword, normEmail } = require('./util');
const { computeAllocation, historyRecords } = require('./fairness');

const H = 3600e3;
const SCHEMA = 2;
const DEMO_PASSWORD = 'court1234';   // documented demo password for seeded students
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(16).toString('hex');
const ADMIN_EMAIL = 'haroonsheik0127@gmail.com';

let db = null;
let dbFile = null;

function makeUser({ name, roll, phone = '', email, password, role = 'user', created }) {
  return {
    id: uid(), name: String(name).trim(), roll: String(roll).trim(),
    phone: String(phone).trim(), email: normEmail(email),
    passwordHash: hashPassword(password), emailVerified: true,
    role, status: 'active', ban: null, created: created || now(),
  };
}

function demoStudents() {
  return [
    ['Haroon Ahmed', '21CS-014', '03001234567'],
    ['Ayesha Khan', '21CS-027', '03011234567'],
    ['Bilal Raza', '22EE-009', '03021234567'],
    ['Sara Malik', '22SE-033', '03031234567'],
    ['Usman Tariq', '21ME-045', '03041234567'],
    ['Hira Noor', '23BBA-12', '03051234567'],
    ['Zain Abbas', '22CS-051', '03061234567'],
  ].map(([name, roll, phone]) => makeUser({
    name, roll, phone,
    email: `${roll.toLowerCase().replace(/\W/g, '')}@example.com`,
    password: DEMO_PASSWORD,
  }));
}

function adminUser() {
  return makeUser({ name: 'Sheikh Haroon', roll: 'ADMIN-01', phone: '', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin' });
}

function stdCase(S, title, details, a, b, status, winner, reason) {
  return {
    id: uid(), type: 'standard', title, details,
    complainant: { name: S[a].name, roll: S[a].roll },
    accused: { name: S[b].name, roll: S[b].roll, email: S[b].email },
    status, winner, reason, created: now() - Math.random() * 72 * H, deadline: 0,
    turn: 'complainant', log: [], likes: [], objections: 0, seeded: 1,
  };
}

// A resolved Resource Dispute so the feed shows Card 10's explainable table.
function seedResourceCase(S) {
  const base = now();
  const claimants = [
    { roll: S[1].roll, name: S[1].name, resource: 'Lab Computer #3', reason: 'Final-year project simulation due tomorrow morning.', deadline: base + 10 * H, urgency: 9 },
    { roll: S[2].roll, name: S[2].name, resource: 'Lab Computer #3', reason: 'Run experiments for a lab report due in two days.', deadline: base + 40 * H, urgency: 7 },
    { roll: S[3].roll, name: S[3].name, resource: 'Lab Computer #3', reason: 'Practice for a programming contest next week.', deadline: base + 150 * H, urgency: 5 },
  ];
  const result = computeAllocation({ resource: 'Lab Computer #3', claimants, history: [], nowTs: base, timeSharing: true, windowMinutes: 180 });
  const c = {
    id: uid(), type: 'resource', title: 'Who gets Lab Computer #3?',
    details: 'Three students need the same lab computer during exam week. Card 10 decides fairly — not first-come-first-served.',
    resource: { name: 'Lab Computer #3', windowMinutes: 180 },
    owner: { name: S[1].name, roll: S[1].roll },
    claimants: claimants.map((c) => ({ ...c, submitted: true })),
    status: 'decided', allocation: result, created: base - 2 * H, deadline: base + 24 * H,
    log: [], likes: [], objections: 0, seeded: 1,
  };
  const resource = { id: uid(), name: 'Lab Computer #3', allocations: historyRecords(result, c.id, 'Lab Computer #3') };
  return { c, resource };
}

function seed() {
  const S = demoStudents();
  const admin = adminUser();
  const { c: rc, resource } = seedResourceCase(S);
  return {
    schemaVersion: SCHEMA,
    students: [...S, admin],
    cases: [
      stdCase(S, 'The Missing Charger', 'Borrowed my laptop charger for "one hour" three weeks ago. Hostel Block C, Room 14.', 1, 2, 'decided', 'complainant', 'Evidence of repeated borrowing without return was persuasive.'),
      stdCase(S, 'Midnight Guitar Concert', 'Played guitar at 2 AM during exam week. Entire floor suffered.', 3, 4, 'decided', 'accused', 'Complainant could not prove the exact time or the disturbance.'),
      stdCase(S, 'Biryani Heist', 'My labelled biryani vanished from the mess fridge. Label was clearly visible.', 5, 6, 'defaulted', 'complainant', 'Accused did not appear within the deadline.'),
      stdCase(S, 'Group Project Ghost', 'Disappeared from the group chat the day before the deadline.', 2, 0, 'decided', 'accused', 'Both parties contributed late; case dismissed in favour of accused.'),
      rc,
    ],
    resources: [resource],
    invitations: [],
    moderation: [],
  };
}

// Upgrade an existing (v1) db.json in place without discarding data.
function migrate(existing) {
  existing.students = existing.students || [];
  for (const s of existing.students) {
    if (!s.id) s.id = uid();
    if (!s.passwordHash) s.passwordHash = hashPassword(DEMO_PASSWORD);
    if (s.emailVerified === undefined) s.emailVerified = true;
    if (!s.role) s.role = 'user';
    if (!s.status) s.status = 'active';
    if (s.ban === undefined) s.ban = null;
    if (!s.created) s.created = now();
    if (s.email) s.email = normEmail(s.email);
  }
  if (!existing.students.some((s) => s.email === ADMIN_EMAIL)) existing.students.push(adminUser());
  existing.cases = existing.cases || [];
  for (const c of existing.cases) {
    if (!c.type) c.type = 'standard';
    if (!Array.isArray(c.likes)) c.likes = [];
    if (!Array.isArray(c.log)) c.log = [];
  }
  existing.resources = existing.resources || [];
  existing.invitations = existing.invitations || [];
  existing.moderation = existing.moderation || [];
  if (!existing.cases.some((c) => c.type === 'resource')) {
    const S = existing.students.filter((s) => s.role !== 'admin');
    if (S.length >= 4) {
      const { c, resource } = seedResourceCase(S);
      existing.cases.push(c);
      existing.resources.push(resource);
    }
  }
  existing.schemaVersion = SCHEMA;
  return existing;
}

function load() {
  dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
  try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch { db = seed(); }
  if (!db.schemaVersion || db.schemaVersion < SCHEMA) migrate(db);
  save();
  return db;
}

// Atomic write: write to a temp file then rename, so a crash mid-write never
// corrupts the database.
function save() {
  if (!dbFile) dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const tmp = `${dbFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dbFile);
}

const getDB = () => db;
const userByRoll = (roll) => db.students.find((s) => s.roll === roll);
const userByEmail = (email) => db.students.find((s) => s.email === normEmail(email));
const userById = (id) => db.students.find((s) => s.id === id);

// Strip secrets before sending a user to the client.
function publicUser(u, full = false) {
  if (!u) return null;
  const base = { id: u.id, name: u.name, roll: u.roll, email: u.email, role: u.role, status: u.status, ban: u.ban || null, emailVerified: !!u.emailVerified, created: u.created };
  return full ? { ...base, phone: u.phone } : base;
}

module.exports = {
  load, save, getDB, userByRoll, userByEmail, userById, publicUser,
  DEMO_PASSWORD, ADMIN_PASSWORD, ADMIN_EMAIL, H,
};