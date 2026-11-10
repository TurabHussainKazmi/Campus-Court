'use strict';
/* ============================================================================
   CAMPUS COURT — frontend logic (vanilla JS, no build step)
   ========================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let T = localStorage.cc_token || '';
let ME = null;
let CASE = null;
let poll = null;
let soundOn = localStorage.cc_sound !== '0';
let pendingInvite = new URLSearchParams(location.search).get('invite') || '';
let introTimers = [];

/* ---- API ----------------------------------------------------------------- */
async function api(path, body, method) {
  const opts = { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' } };
  if (T) opts.headers.authorization = 'Bearer ' + T;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api/' + path, opts);
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || 'Request failed'); e.status = r.status; e.data = j; throw e; }
  return j;
}

/* ---- UI helpers ---------------------------------------------------------- */
function show(id) { $$('.view').forEach((v) => v.classList.remove('on')); $('#' + id).classList.add('on'); }
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'glass toast show' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3600);
}
function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
function loading(el) { el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>'; }
function empty(msg, ico) { return `<div class="empty"><div class="ico">${ico || '⚖'}</div><p>${esc(msg)}</p></div>`; }
function modal(html) { $('#modal').innerHTML = html; $('#modal-back').classList.add('on'); }
function closeModal() { $('#modal-back').classList.remove('on'); }
$('#modal-back').addEventListener('click', (e) => { if (e.target.id === 'modal-back') closeModal(); });

/* ---- sound (WebAudio, no files) ----------------------------------------- */
let AC; const ac = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());
function tone(f, d = 0.12, type = 'sine', v = 0.12) {
  if (!soundOn) return;
  try { const a = ac(), o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + d); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + d); } catch {}
}
function gavelSound() {
  if (!soundOn) return;
  try {
    const a = ac(), n = a.createBuffer(1, a.sampleRate * 0.25, a.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
    const s = a.createBufferSource(); s.buffer = n; const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    s.connect(f).connect(a.destination); s.start(); tone(85, 0.3, 'sine', 0.5);
  } catch {}
  const g = $('#court-gavel'); if (g) { g.classList.remove('bang'); void g.offsetWidth; g.classList.add('bang'); }
}
function speak(text) {
  if (!soundOn || reduced) return;
  try { const u = new SpeechSynthesisUtterance(text); u.rate = 0.98; u.pitch = 0.8; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
}

/* ---- cinematic intro ----------------------------------------------------- */
function playIntro() {
  const intro = $('#intro'); intro.classList.add('on');
  const scenes = ['#scene1', '#scene2', '#scene3'];
  const setScene = (i) => scenes.forEach((s, k) => $(s).classList.toggle('show', k === i));
  if (reduced) { $('#intro-credits').classList.add('show'); introTimers.push(setTimeout(endIntro, 1400)); return; }
  setScene(0); tone(110, 1.4, 'sawtooth', 0.08);
  introTimers.push(setTimeout(() => { setScene(1); tone(330, 0.5, 'sine', 0.08); }, 2200));
  introTimers.push(setTimeout(() => setScene(2), 4400));
  introTimers.push(setTimeout(() => { $('#intro-gavel').classList.add('gavel-strike'); $('#intro-flash').classList.add('go'); gavelSound(); }, 5000));
  introTimers.push(setTimeout(() => { $$('.scene').forEach((s) => s.classList.remove('show')); $('#intro-credits').classList.add('show'); tone(523, 0.5, 'sine', 0.1); setTimeout(() => tone(784, 0.6, 'sine', 0.1), 220); }, 6600));
  introTimers.push(setTimeout(endIntro, 9600));
}
function endIntro() { introTimers.forEach(clearTimeout); introTimers = []; $('#intro').classList.remove('on'); localStorage.cc_intro_seen = '1'; boot(); }
$('#skip-intro').addEventListener('click', endIntro);

/* ---- auth ---------------------------------------------------------------- */
$('#tab-login').addEventListener('click', () => switchAuth('login'));
$('#tab-register').addEventListener('click', () => switchAuth('register'));
function switchAuth(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#login-form').style.display = which === 'login' ? 'block' : 'none';
  $('#register-form').style.display = which === 'register' ? 'block' : 'none';
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#login-err').textContent = '';
  try {
    const r = await api('login', { email: $('#li-email').value, password: $('#li-pass').value });
    await onAuthed(r);
  } catch (err) { $('#login-err').textContent = err.message; tone(150, 0.25, 'sawtooth'); }
});
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#register-err').textContent = '';
  try {
    const r = await api('register', { name: $('#rg-name').value, roll: $('#rg-roll').value, email: $('#rg-email').value, phone: $('#rg-phone').value, password: $('#rg-pass').value });
    toast(r.adminNotified ? 'Welcome! The administrator was notified by email.' : 'Welcome to Campus Court!', 'ok');
    await onAuthed(r);
  } catch (err) { $('#register-err').textContent = err.message; tone(150, 0.25, 'sawtooth'); }
});
async function onAuthed(r) {
  T = localStorage.cc_token = r.token; ME = r.me; localStorage.cc_me = JSON.stringify(ME);
  gavelSound();
  if (pendingInvite) { const tok = pendingInvite; pendingInvite = ''; history.replaceState(0, '', '/'); await acceptInvite(tok); return; }
  enterApp();
}
async function logout() {
  try { await api('logout', {}); } catch {}
  T = ''; ME = null; localStorage.removeItem('cc_token'); localStorage.removeItem('cc_me'); stopPoll();
  show('auth'); switchAuth('login');
}

/* ---- boot ---------------------------------------------------------------- */
async function boot() {
  if (pendingInvite) { await showInviteLanding(); return; }
  if (T) {
    try { const r = await api('me'); ME = r.me; localStorage.cc_me = JSON.stringify(ME); enterApp(); }
    catch { T = ''; localStorage.removeItem('cc_token'); show('auth'); }
  } else show('auth');
}
function enterApp() { show('app'); renderNav(); navigate('home'); }

/* ---- nav ----------------------------------------------------------------- */
function renderNav() {
  const links = [['home', 'Home'], ['feed', 'Community Feed'], ['file', 'File a Case'], ['mine', 'My Cases']];
  if (ME && ME.role === 'admin') links.push(['admin', 'Admin']);
  links.push(['profile', 'My Profile']);
  $('#nav').innerHTML =
    `<div class="brand"><img src="/cc-logo.svg" alt=""><span>CAMPUS COURT</span></div>` +
    links.map(([k, l]) => `<button class="ghost" data-nav="${k}">${l}</button>`).join('') +
    `<button class="ghost sm" id="sound-toggle" title="Toggle sound">${soundOn ? '🔊' : '🔇'}</button>` +
    `<button class="ghost sm" id="logout-btn">Logout</button>` +
    `<span class="who">${esc(ME ? ME.name : '')}</span>`;
  $$('#nav [data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
  $('#logout-btn').addEventListener('click', logout);
  $('#sound-toggle').addEventListener('click', () => { soundOn = !soundOn; localStorage.cc_sound = soundOn ? '1' : '0'; $('#sound-toggle').textContent = soundOn ? '🔊' : '🔇'; if (!soundOn) try { speechSynthesis.cancel(); } catch {} });
}
function setActiveNav(name) { $$('#nav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name)); }

function navigate(name) {
  stopPoll(); setActiveNav(name);
  const m = $('#main');
  if (name === 'home') return renderHome(m);
  if (name === 'feed') return renderFeed(m);
  if (name === 'file') return renderFile(m);
  if (name === 'mine') return renderMine(m);
  if (name === 'admin') return renderAdmin(m);
  if (name === 'profile') return renderProfile(m);
}

/* ---- home ---------------------------------------------------------------- */
async function renderHome(m) {
  m.innerHTML = `
    <div class="hero">
      <img class="logo" src="/cc-logo.svg" alt="">
      <h1>Welcome to <span class="accent">Campus Court</span></h1>
      <p>A dignified, fair courtroom for campus disputes — and a transparent way to share limited resources. No first-come-first-served. Every decision is explained.</p>
      <div class="cta">
        <button data-go="file">File a Case</button>
        <button class="ghost" data-go="feed">Explore the Feed</button>
      </div>
      <div class="stats-strip" id="home-stats"></div>
    </div>
    <div class="quick-grid">
      <div class="glass quick" data-go="file"><div class="ico">📝</div><h3>File a Case</h3><p class="muted small">Summon a student or invite an external email.</p></div>
      <div class="glass quick" data-go="resource"><div class="ico">⚖</div><h3>Resource Dispute</h3><p class="muted small">Card 10 — fair sharing of one resource.</p></div>
      <div class="glass quick" data-go="mine"><div class="ico">📁</div><h3>My Cases</h3><p class="muted small">Your hearings and invitations.</p></div>
      <div class="glass quick" data-go="profile"><div class="ico">👤</div><h3>My Profile</h3><p class="muted small">Your details and account.</p></div>
    </div>
    <h2 class="section-title">Recent Cases</h2><div id="home-recent"><div class="loading"><div class="spinner"></div></div></div>
    <h2 class="section-title">Available Courtrooms</h2><div id="home-rooms"></div>`;
  $$('[data-go]', m).forEach((b) => b.addEventListener('click', () => { const go = b.dataset.go; if (go === 'resource') renderFile($('#main'), 'resource'); else navigate(go); }));
  try {
    const [feed, rooms, mine] = await Promise.all([api('feed'), api('courtrooms'), api('mine')]);
    $('#home-stats').innerHTML = [
      ['Cases', feed.length], ['Live courtrooms', rooms.length], ['My cases', mine.cases.length], ['Resource disputes', feed.filter((c) => c.type === 'resource').length],
    ].map(([l, n]) => `<div class="glass stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
    const recent = feed.slice(0, 4);
    $('#home-recent').innerHTML = recent.length ? `<div class="bento">${recent.map(card).join('')}</div>` : empty('No cases yet. Be the first to file.', '🏛');
    $('#home-rooms').innerHTML = rooms.length ? `<div class="bento">${rooms.map((r) => `<div class="glass post" style="--accent:${r.type === 'resource' ? 'var(--gold)' : 'var(--blue)'}"><span class="badge ${r.status === 'live' ? 'green' : 'gold'}">${esc(r.status)}</span><h3>${esc(r.title)}</h3><p class="muted small">${r.type === 'resource' ? 'Resource dispute' : 'Standard dispute'}</p><div class="post-actions"><button class="sm" data-open="${r.id}" data-type="${r.type}">Enter</button></div></div>`).join('')}</div>` : empty('No active courtrooms right now.', '🚪');
    wireCards(m);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---- case cards ---------------------------------------------------------- */
function statusBadge(c) {
  if (c.type === 'resource') return c.status === 'decided' ? '<span class="badge gold">Allocated</span>' : '<span class="badge blue">Collecting needs</span>';
  return { waiting: '<span class="badge">Awaiting accused</span>', live: '<span class="badge green">🔴 In session</span>', decided: '<span class="badge gold">Verdict</span>', defaulted: '<span class="badge gold">Won by default</span>' }[c.status] || '<span class="badge">' + esc(c.status) + '</span>';
}
function card(c) {
  const accent = c.type === 'resource' ? 'var(--gold)' : 'var(--blue)';
  let parties;
  if (c.type === 'resource') {
    parties = `<div class="vs"><div class="av gold">⚖</div><span class="name">${esc(c.resource.name)}</span><i>·</i><span class="muted small">${c.claimants.length} claimants</span></div>`;
  } else {
    const w = c.winner;
    parties = `<div class="vs"><div class="av blue">${initials(c.complainant.name)}</div><span class="name blue ${w === 'complainant' ? 'win' : w ? 'lose' : ''}">${esc(c.complainant.name)}</span><i>vs</i><span class="name red ${w === 'accused' ? 'win' : w ? 'lose' : ''}">${esc(c.accused.name)}</span><div class="av red">${initials(c.accused.name)}</div></div>`;
  }
  const decided = c.status === 'decided' || c.status === 'defaulted';
  let result = '';
  if (c.type === 'resource' && c.status === 'decided' && c.allocation) {
    result = `<p class="small" style="margin:10px 0"><span class="win">⚖ ${c.allocation.allocation.mode === 'time-share' ? 'Time shared fairly' : esc(c.allocation.allocation.winnerName) + ' allocated'}</span></p>`;
  } else if (decided && c.winner) {
    result = `<p class="small" style="margin:10px 0"><span class="win">🏆 ${esc(c[c.winner].name)}</span> — ${esc(c.reason || '')}</p>`;
  }
  const canEnter = c.type === 'resource' ? true : !decided;
  return `<div class="glass post" style="--accent:${accent}">
    ${statusBadge(c)} ${c.type === 'resource' ? '<span class="badge gold">Card 10</span>' : ''}
    <h3>${esc(c.title)}</h3>${parties}
    <p class="muted small">${esc((c.details || '').slice(0, 160))}</p>${result}
    <div class="post-actions">
      <button class="like" data-like="${c.id}">♥ ${c.likes || 0}</button>
      ${canEnter ? `<button class="sm" data-open="${c.id}" data-type="${c.type}">${c.type === 'resource' ? 'View dispute' : decided ? 'View' : 'Enter Court'}</button>` : `<button class="sm ghost" data-open="${c.id}" data-type="${c.type}">View</button>`}
    </div></div>`;
}
function wireCards(root) {
  $$('[data-open]', root).forEach((b) => b.addEventListener('click', () => b.dataset.type === 'resource' ? openResource(b.dataset.open) : openCase(b.dataset.open)));
  $$('[data-like]', root).forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('cases/' + b.dataset.like + '/like', {}); b.textContent = '♥ ' + r.likes; b.classList.toggle('on', r.liked); tone(r.liked ? 880 : 440, 0.08); } catch (e) { toast(e.message, 'err'); }
  }));
}

/* ---- feed ---------------------------------------------------------------- */
async function renderFeed(m) {
  loading(m);
  try {
    const feed = await api('feed');
    m.innerHTML = `<h2 class="section-title">Community Feed</h2>` + (feed.length ? `<div class="bento">${feed.map(card).join('')}</div>` : empty('No cases yet.', '🏛'));
    wireCards(m);
  } catch (e) { m.innerHTML = empty(e.message, '⚠'); }
}

/* ---- file a case (standard + resource) ----------------------------------- */
async function renderFile(m, type) {
  const active = type || 'standard';
  m.innerHTML = `<h2 class="section-title">File a Case</h2>
    <div class="glass form-card">
      <div class="type-switch">
        <button class="ghost ${active === 'standard' ? 'active' : ''}" data-type="standard">Standard dispute</button>
        <button class="ghost ${active === 'resource' ? 'active' : ''}" data-type="resource">Resource dispute · Card 10</button>
      </div>
      <div id="file-body"></div>
    </div>`;
  $$('.type-switch button', m).forEach((b) => b.addEventListener('click', () => renderFile(m, b.dataset.type)));
  let students = [];
  try { students = await api('students'); } catch {}
  if (active === 'standard') renderStandardForm($('#file-body'), students);
  else renderResourceForm($('#file-body'), students);
}
function studentOptions(students) { return students.map((s) => `<option value="${esc(s.roll)}">${esc(s.name)} — ${esc(s.roll)}</option>`).join(''); }
function renderStandardForm(el, students) {
  el.innerHTML = `
    <p class="muted small" style="margin-bottom:14px">Your details are filled in automatically. Name the other party — a registered student or an external email.</p>
    <label>Accused (registered student)</label>
    <select id="f-accused"><option value="">— Choose a student —</option>${studentOptions(students)}</select>
    <label>…or invite an external student by email</label>
    <input id="f-email" type="email" placeholder="student@example.com (overrides the dropdown if filled)">
    <label>Case title</label><input id="f-title" maxlength="80" placeholder="e.g. The Stolen Sandwich">
    <label>What happened?</label><textarea id="f-details" maxlength="500" rows="4"></textarea>
    <div class="err" id="f-err"></div>
    <button style="width:100%" id="f-submit">Summon the other party ⚖</button>`;
  $('#f-submit').addEventListener('click', async () => {
    $('#f-err').textContent = '';
    const email = $('#f-email').value.trim();
    const body = { title: $('#f-title').value, details: $('#f-details').value };
    if (email) body.accusedEmail = email; else body.accusedRoll = $('#f-accused').value;
    try {
      const r = await api('cases', body);
      gavelSound();
      toast(r.emailed ? '📧 Summons emailed. Timer started!' : r.inviteLink ? 'Invitation created (email in dry-run).' : 'Case filed. Invitation created.', 'ok');
      if (r.inviteLink) showInviteLink(r.inviteLink);
      setTimeout(() => openCase(r.id), 700);
    } catch (e) { $('#f-err').textContent = e.message; }
  });
}
function toLocalInput(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function claimantRow(students, owner) {
  const def = toLocalInput(Date.now() + 24 * 3600e3);
  if (owner) {
    return `<div class="claimant-row" data-owner="1">
      <b>${esc(ME.name)} (you)</b>
      <label>Why do you need it?</label><input class="cl-reason" placeholder="e.g. Final-year project due tomorrow">
      <div class="row"><div><label>Urgency (1–10)</label><input class="cl-urgency" type="number" min="1" max="10" value="7"></div>
      <div><label>Deadline</label><input class="cl-deadline" type="datetime-local" value="${def}"></div></div>
    </div>`;
  }
  return `<div class="claimant-row">
    <button class="ghost sm remove" type="button">✕</button>
    <label>Student</label><select class="cl-student"><option value="">External student (email)</option>${studentOptions(students)}</select>
    <input class="cl-email" type="email" placeholder="student@example.com">
    <label>Why do they need it?</label><input class="cl-reason" placeholder="Their reason">
    <div class="row"><div><label>Urgency (1–10)</label><input class="cl-urgency" type="number" min="1" max="10" value="6"></div>
    <div><label>Deadline</label><input class="cl-deadline" type="datetime-local" value="${def}"></div></div>
  </div>`;
}
function renderResourceForm(el, students) {
  el.innerHTML = `
    <p class="muted small" style="margin-bottom:14px"><b>Card 10 — Fair Resource Sharing.</b> Gather each student's need, score urgency, check fairness history, then deliver an explainable allocation. Not first-come-first-served.</p>
    <label>Dispute title</label><input id="r-title" maxlength="80" placeholder="e.g. Who gets Lab Computer #3?">
    <div class="row">
      <div><label>Resource in dispute</label><input id="r-name" placeholder="e.g. Lab Computer #3"></div>
      <div><label>Available window (minutes)</label><input id="r-window" type="number" min="0" value="180"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--ivory)"><input type="checkbox" id="r-timeshare" checked style="width:auto;margin:0"> Split the time window fairly (time-sharing)</label>
    <div class="divider"></div>
    <h3 style="margin-bottom:10px">Competing students &amp; their needs</h3>
    <div id="claimants">${claimantRow(students, true)}${claimantRow(students, false)}</div>
    <button class="ghost sm" id="add-claimant" type="button">+ Add another student</button>
    <div class="err" id="r-err" style="margin-top:12px"></div>
    <button style="width:100%;margin-top:8px" id="r-submit">Create dispute &amp; score fairly ⚖</button>`;
  const wireRow = (row) => {
    const sel = $('.cl-student', row), email = $('.cl-email', row);
    if (sel) { const toggle = () => email.style.display = sel.value ? 'none' : 'block'; sel.addEventListener('change', toggle); toggle(); }
    const rm = $('.remove', row); if (rm) rm.addEventListener('click', () => row.remove());
  };
  $$('.claimant-row', el).forEach(wireRow);
  $('#add-claimant').addEventListener('click', () => {
    const div = document.createElement('div'); div.innerHTML = claimantRow(students, false);
    const row = div.firstElementChild; $('#claimants').appendChild(row); wireRow(row);
  });
  $('#r-submit').addEventListener('click', async () => {
    $('#r-err').textContent = '';
    const claimants = $$('.claimant-row', el).map((row) => {
      const base = { reason: $('.cl-reason', row).value, urgency: +$('.cl-urgency', row).value, deadline: new Date($('.cl-deadline', row).value).getTime() };
      if (row.dataset.owner) return { ...base, roll: ME.roll };
      const roll = $('.cl-student', row).value;
      if (roll) return { ...base, roll };
      const email = $('.cl-email', row).value.trim(); return email ? { ...base, email } : null;
    }).filter(Boolean);
    const body = { title: $('#r-title').value, resource: { name: $('#r-name').value, windowMinutes: +$('#r-window').value }, timeSharing: $('#r-timeshare').checked, claimants };
    try {
      const r = await api('resource', body);
      gavelSound(); toast('Resource dispute created.', 'ok');
      const links = (r.invitations || []).filter((i) => i.link);
      if (links.length) showInviteLink(links[0].link, links);
      setTimeout(() => openResource(r.id), 700);
    } catch (e) { $('#r-err').textContent = e.message; }
  });
}
function showInviteLink(link, all) {
  const list = all && all.length > 1 ? all.map((i) => `<p class="small" style="word-break:break-all"><b>${esc(i.email || i.roll || '')}</b>: <a href="${esc(i.link)}">${esc(i.link)}</a></p>`).join('') : `<p class="small" style="word-break:break-all"><a href="${esc(link)}">${esc(link)}</a></p>`;
  modal(`<h3>Invitation link</h3><p class="muted small">Email is in dry-run mode (no Gmail configured). Share this secure link with the invitee:</p>${list}<button style="width:100%;margin-top:14px" onclick="document.getElementById('modal-back').classList.remove('on')">Got it</button>`);
}

/* ---- my cases + invitations ---------------------------------------------- */
async function renderMine(m) {
  loading(m);
  try {
    const r = await api('mine');
    let inv = '';
    if (r.invitations.length) {
      inv = `<h2 class="section-title">Invitations</h2><div class="bento">${r.invitations.map((i) => `<div class="glass post" style="--accent:var(--gold)"><span class="badge gold">Invitation</span><h3>${esc(i.caseTitle || 'A case')}</h3><p class="muted small">From ${esc(i.invitedBy)}</p><div class="post-actions"><button class="sm" data-accept="${i.id}">Accept &amp; join</button></div></div>`).join('')}</div>`;
    }
    m.innerHTML = `<h2 class="section-title">My Cases</h2>
      <p class="muted small">You have filed <b>${r.filedToday}</b> of <b>${r.dailyLimit}</b> cases today.</p>
      ${inv}
      ${r.cases.length ? `<div class="bento" style="margin-top:16px">${r.cases.map(card).join('')}</div>` : empty('You have no cases yet. File one to begin.', '📁')}`;
    wireCards(m);
    $$('[data-accept]', m).forEach((b) => b.addEventListener('click', async () => {
      try { const res = await api('invitations/accept', { id: b.dataset.accept }); toast('Joined the case.', 'ok'); res.type === 'resource' ? openResource(res.caseId) : openCase(res.caseId); }
      catch (e) { toast(e.message, 'err'); }
    }));
  } catch (e) { m.innerHTML = empty(e.message, '⚠'); }
}

/* ---- standard courtroom -------------------------------------------------- */
let lastLog = 0, lastStatus = '';
async function openCase(id) {
  stopPoll(); setActiveNav(''); lastLog = 0; lastStatus = '';
  const m = $('#main'); loading(m);
  try { CASE = await api('cases/' + id); } catch (e) { m.innerHTML = empty(e.message, '⚠'); return; }
  renderRoom(m);
  setTimeout(gavelSound, 400);
  poll = setInterval(() => refreshCase(id), 2000);
}
function balanceSVG() {
  return `<svg viewBox="0 0 70 90" aria-hidden="true"><g stroke="#c9a24b" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="35" y1="14" x2="35" y2="70"/><g class="balance-beam" id="balance-beam"><line x1="12" y1="26" x2="58" y2="26"/><path d="M12 26 L5 44 L19 44 Z" fill="#c9a24b" fill-opacity="0.2"/><path d="M58 26 L51 44 L65 44 Z" fill="#c9a24b" fill-opacity="0.2"/></g><line x1="22" y1="74" x2="48" y2="74"/><circle cx="35" cy="14" r="3" fill="#c9a24b"/></g></svg>`;
}
function renderRoom(m) {
  const c = CASE;
  m.innerHTML = `
    <div class="room-head"><button class="ghost sm" id="leave-room">◂ Leave</button><h2>${esc(c.title)}</h2><div class="timer" id="timer"></div></div>
    <div class="faceoff">
      <div class="glass party blue"><div class="av blue">${initials(c.complainant.name)}</div><div class="role">Plaintiff</div><h3>${esc(c.complainant.name)}</h3><div class="mic-state" id="mic-complainant"></div></div>
      <div class="balance-divider">${balanceSVG()}</div>
      <div class="glass party red"><div class="av red">${initials(c.accused.name)}</div><div class="role">Opposing party</div><h3>${esc(c.accused.name)}</h3><div class="mic-state" id="mic-accused"></div></div>
    </div>
    <div class="court-grid">
      <div class="glass bench">
        <div class="gavel-wrap"><div class="gavel" id="court-gavel"><div class="gavel-head"></div><div class="gavel-handle"></div></div></div>
        <div class="gavel-block"></div>
        <h3 style="margin-top:16px;color:var(--gold)">The Hon. Judge</h3>
        <p class="muted small">Understands English &amp; Urdu</p>
        <div class="divider"></div>
        <button class="obj-btn" id="objection-btn">OBJECTION!</button>
        <p class="muted small" style="margin-top:10px">Only the speaker's mic is open. The other side may object.</p>
        <div id="demo-toggle" style="display:none;margin-top:12px"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;color:var(--ivory);font-size:0.85rem"><input type="checkbox" id="demo-as" style="width:auto;margin:0"> Demo: act as the other side</label></div>
      </div>
      <div class="glass" style="padding:14px">
        <div class="log" id="log"></div>
        <div id="verdict"></div>
        <div class="say"><input id="say-input" placeholder="Type your argument (English / Urdu)…"><button class="ghost" id="mic-btn" title="Dictate">🎤</button><button id="speak-btn">Speak</button></div>
        <p class="muted small" id="turn-hint" style="margin-top:8px"></p>
      </div>
    </div>`;
  $('#leave-room').addEventListener('click', () => navigate('mine'));
  $('#speak-btn').addEventListener('click', speak_);
  $('#say-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') speak_(); });
  $('#objection-btn').addEventListener('click', objection);
  $('#mic-btn').addEventListener('click', dictate);
  $('#demo-toggle').style.display = c.demo ? 'block' : 'none';
  paintCase();
}
function effRole() {
  const c = CASE; if (!c) return null;
  if (c.demo && $('#demo-as') && $('#demo-as').checked) return c.you === 'complainant' ? 'accused' : 'complainant';
  return c.you || (c.demo ? 'complainant' : null);
}
async function refreshCase(id) { try { CASE = await api('cases/' + id); paintCase(); } catch (e) { /* transient */ } }
function paintCase() {
  const c = CASE; if (!c || !$('#log')) return;
  const open = c.status === 'waiting' || c.status === 'live';
  const log = $('#log');
  c.log.slice(lastLog).forEach((msg) => {
    const who = msg.who === 'judge' ? '⚖ Judge' : msg.who === 'complainant' ? c.complainant.name : c.accused.name;
    log.insertAdjacentHTML('beforeend', `<div class="msg ${esc(msg.who)}"><small>${esc(who)}</small>${esc(msg.text)}</div>`);
    if (msg.who === 'judge') speak(msg.text);
    if (/OBJECTION|VERDICT/.test(msg.text)) gavelSound();
  });
  if (c.log.length > lastLog) { log.scrollTop = log.scrollHeight; lastLog = c.log.length; }
  const as = effRole();
  ['complainant', 'accused'].forEach((r) => { const el = $('#mic-' + r); if (el) { const live = open && c.turn === r; el.innerHTML = live ? '<span class="mic-open">● MIC OPEN</span>' : '<span class="mic-muted">○ MIC MUTED</span>'; } });
  const beam = $('#balance-beam'); if (beam) beam.style.transform = !open ? 'rotate(0deg)' : c.turn === 'complainant' ? 'rotate(-7deg)' : 'rotate(7deg)';
  const my = open && as === c.turn;
  $('#say-input').disabled = !my; $('#speak-btn').disabled = !my; $('#mic-btn').disabled = !my;
  $('#objection-btn').disabled = !(open && c.status === 'live' && as && as !== c.turn);
  $('#turn-hint').textContent = !open ? 'Court adjourned.' : my ? '🎙 Your mic is open — speak.' : 'Waiting for ' + (c[c.turn] ? c[c.turn].name : c.turn) + '…';
  if (c.deadline && open) {
    const ms = c.deadline - Date.now();
    if (ms > 0) { const h = Math.floor(ms / 3600e3), mm = Math.floor((ms % 3600e3) / 60e3), ss = Math.floor((ms % 60e3) / 1e3); $('#timer').textContent = `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; }
    else $('#timer').textContent = 'Time up';
  } else $('#timer').textContent = '';
  if (!open && lastStatus !== c.status) {
    lastStatus = c.status;
    $('#verdict').innerHTML = `<div class="glass verdict-card"><h2>🏆 ${esc(c[c.winner] ? c[c.winner].name : c.winner)} wins</h2><p class="muted" style="margin-top:8px">${esc(c.reason || '')}</p><button style="margin-top:16px" id="verdict-back">Back to My Cases</button></div>`;
    $('#verdict-back').addEventListener('click', () => navigate('mine'));
    tone(523, 0.3); setTimeout(() => tone(784, 0.5), 250);
  }
}
async function speak_() {
  const t = $('#say-input').value.trim(); if (!t) return; $('#say-input').value = '';
  const as = effRole(); const body = { text: t }; if (CASE.demo && ($('#demo-as').checked || !CASE.you)) body.as = as;
  try { await api(`cases/${CASE.id}/speak`, body); await refreshCase(CASE.id); } catch (e) { toast(e.message, 'err'); }
}
async function objection() {
  const as = effRole(); const body = {}; if (CASE.demo && ($('#demo-as').checked || !CASE.you)) body.as = as;
  try { await api(`cases/${CASE.id}/objection`, body); await refreshCase(CASE.id); } catch (e) { toast(e.message, 'err'); }
}
function dictate() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return toast('Speech input not supported — please type.');
  const r = new R(); r.lang = /[\u0600-\u06FF]/.test($('#say-input').value) ? 'ur-PK' : 'en-IN';
  r.onresult = (e) => { $('#say-input').value = e.results[0][0].transcript; }; r.start(); toast('Listening…');
}

/* ---- resource dispute (Card 10) ------------------------------------------ */
async function openResource(id) {
  stopPoll(); setActiveNav('');
  const m = $('#main'); loading(m);
  try { CASE = await api('cases/' + id); } catch (e) { m.innerHTML = empty(e.message, '⚠'); return; }
  renderResource(m);
  if (CASE.status === 'collecting') poll = setInterval(async () => { try { CASE = await api('cases/' + id); if (CASE.status !== 'collecting') { stopPoll(); renderResource(m); } } catch {} }, 3000);
}
function renderResource(m) {
  const c = CASE;
  const decided = c.status === 'decided' && c.allocation;
  const you = c.you;
  let claimCards = c.claimants.map((cl, i) => {
    const accent = ['var(--blue)', 'var(--red)', 'var(--gold)'][i % 3];
    return `<div class="glass claimant-card" style="border-top-color:${accent}">
      <h4>${esc(cl.name)}${cl.roll === (ME && ME.roll) ? ' (you)' : ''}</h4>
      <div class="meta">${cl.submitted ? esc(cl.reason || 'No reason given') : '<i>Has not submitted their need yet</i>'}</div>
      ${cl.submitted ? `<div class="meta">Urgency: <b>${cl.urgency}/10</b></div><div class="urgency-bar"><span style="width:${cl.urgency * 10}%"></span></div><div class="meta">Deadline: ${new Date(cl.deadline).toLocaleString()}</div>` : ''}
    </div>`;
  }).join('');
  let action = '';
  const myClaim = c.claimants.find((cl) => cl.roll === (ME && ME.roll));
  if (!decided) {
    if (myClaim && !myClaim.submitted) {
      action += `<div class="glass form-card" style="margin:0 0 16px"><h3>Submit your need</h3>
        <label>Why do you need it?</label><input id="cl-reason" placeholder="Your reason">
        <div class="row"><div><label>Urgency (1–10)</label><input id="cl-urgency" type="number" min="1" max="10" value="7"></div>
        <div><label>Deadline</label><input id="cl-deadline" type="datetime-local" value="${toLocalInput(Date.now() + 24 * 3600e3)}"></div></div>
        <button id="cl-submit" style="width:100%">Submit my need</button></div>`;
    }
    if (you === 'owner') {
      const submitted = c.claimants.filter((x) => x.submitted).length;
      action += `<div class="glass" style="padding:20px;margin-bottom:16px;text-align:center"><p class="muted small">${submitted} of ${c.claimants.length} students have submitted their needs.</p><button id="resolve-btn" ${submitted < 2 ? 'disabled' : ''}>Deliver fair allocation ⚖</button><button class="ghost sm" id="invite-more" style="margin-left:8px">Invite another student</button></div>`;
    }
  }
  let result = '';
  if (decided) {
    const a = c.allocation;
    const rows = a.table.map((r) => `<tr class="${r.rank === 1 ? 'winner rank-1' : ''}"><td>${r.rank}. ${esc(r.name)}</td><td>${r.urgency}</td><td>${r.need}<div class="muted small">${esc(r.reason || '')}</div></td><td>${r.fairness}</td><td class="total">${r.total}</td><td>${esc(r.decision)}</td></tr>`).join('');
    let alloc;
    if (a.allocation.mode === 'time-share') {
      alloc = `<div class="timeshare">${a.allocation.slots.filter((s) => s.minutes > 0).map((s) => `<div class="slot"><div class="mins">${s.minutes} min</div><div class="muted small">${esc(s.name)}</div></div>`).join('')}</div>`;
    } else {
      alloc = `<p style="margin:10px 0"><span class="win">⚖ ${esc(a.allocation.winnerName)} receives the resource.</span></p>`;
    }
    result = `<div class="glass" style="padding:22px;margin-bottom:16px">
      <h3 style="color:var(--gold);margin-bottom:6px">Explainable allocation</h3>
      <p class="muted small">Weights: urgency 40% · need 35% · fairness 25%. Deterministic — no AI invents these scores.</p>
      <div class="table-scroll"><table class="score-table"><thead><tr><th>Student</th><th>Urgency</th><th>Actual need</th><th>Fairness</th><th>Total</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${alloc}
      <div class="explain-box">${esc(a.explanation)}</div>
      ${a.aiNote ? `<div class="ai-note"><span class="tag">AI commentary — advisory only, does not affect the decision</span>${esc(a.aiNote.text)}</div>` : ''}
    </div>`;
  }
  m.innerHTML = `
    <div class="room-head"><button class="ghost sm" id="leave-res">◂ Leave</button><h2>${esc(c.title)}</h2><span class="badge gold">Card 10</span></div>
    <div class="glass resource-head"><div class="ico">⚖</div><h3>${esc(c.resource.name)}</h3><p class="muted small">${c.timeSharing ? `Time-sharing ${c.resource.windowMinutes} minutes fairly` : 'Exclusive allocation'} · ${decided ? 'Decided' : 'Collecting needs'}</p><p class="muted small">${esc(c.details || '')}</p></div>
    <div class="claimant-cards">${claimCards}</div>
    ${action}${result}`;
  $('#leave-res').addEventListener('click', () => navigate('mine'));
  if ($('#cl-submit')) $('#cl-submit').addEventListener('click', async () => {
    try { await api(`cases/${c.id}/claim`, { reason: $('#cl-reason').value, urgency: +$('#cl-urgency').value, deadline: new Date($('#cl-deadline').value).getTime(), resource: c.resource.name }); toast('Your need was submitted.', 'ok'); openResource(c.id); } catch (e) { toast(e.message, 'err'); }
  });
  if ($('#resolve-btn')) $('#resolve-btn').addEventListener('click', async () => {
    try { const r = await api(`cases/${c.id}/resolve`, {}); CASE = r; gavelSound(); stopPoll(); renderResource(m); toast('Allocation delivered.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });
  if ($('#invite-more')) $('#invite-more').addEventListener('click', () => inviteMoreModal(c.id));
}
function inviteMoreModal(caseId) {
  modal(`<h3>Invite another student</h3><p class="muted small">Add a registered roll number or an external email.</p>
    <label>Roll number</label><input id="im-roll" placeholder="21CS-014">
    <label>…or email</label><input id="im-email" type="email" placeholder="student@example.com">
    <div class="err" id="im-err"></div>
    <button style="width:100%" id="im-send">Send invitation</button>`);
  $('#im-send').addEventListener('click', async () => {
    const body = {}; const roll = $('#im-roll').value.trim(), email = $('#im-email').value.trim();
    if (email) body.email = email; else if (roll) body.roll = roll; else { $('#im-err').textContent = 'Enter a roll or email.'; return; }
    try { const r = await api(`cases/${caseId}/invite`, body); closeModal(); toast('Invitation sent.', 'ok'); if (r.link) showInviteLink(r.link); openResource(caseId); }
    catch (e) { $('#im-err').textContent = e.message; }
  });
}

/* ---- invitations landing ------------------------------------------------- */
async function showInviteLanding() {
  show('invite');
  const el = $('#invite-content'); loading(el);
  try {
    const p = await api('invitations/' + pendingInvite + '/preview');
    const valid = p.status === 'pending';
    el.innerHTML = `<img class="logo" src="/cc-logo.svg" alt=""><h2 class="center-text">You're invited</h2>
      <p class="center-text muted">${esc(p.inviter)} invited you to <b>${esc(p.caseTitle || 'a case')}</b>.</p>
      ${valid ? `<p class="center-text small muted">Log in or register to join. This secure link expires ${new Date(p.expires).toLocaleString()}.</p>
        <div class="auth-tabs"><button class="ghost" id="inv-login">Log in</button><button class="ghost active" id="inv-register">Register</button></div>
        <button style="width:100%" id="inv-continue">Continue to accept</button>`
        : `<div class="err center-text">This invitation is ${esc(p.status)} and can no longer be used.</div><button class="ghost" style="width:100%" id="inv-home">Go to Campus Court</button>`}`;
    if (valid) {
      $('#inv-continue').addEventListener('click', () => { show('auth'); switchAuth('register'); toast('After you sign in, you will join automatically.'); });
    } else {
      pendingInvite = ''; history.replaceState(0, '', '/');
      $('#inv-home').addEventListener('click', boot);
    }
  } catch (e) { el.innerHTML = `<div class="err center-text">${esc(e.message)}</div><button class="ghost" style="width:100%" onclick="location.href='/'">Go to Campus Court</button>`; }
}
async function acceptInvite(token) {
  try { const r = await api('invitations/accept', { token }); toast('You joined the case.', 'ok'); enterApp(); setTimeout(() => r.type === 'resource' ? openResource(r.caseId) : openCase(r.caseId), 400); }
  catch (e) { toast(e.message, 'err'); enterApp(); }
}

/* ---- profile ------------------------------------------------------------- */
async function renderProfile(m) {
  let me = ME;
  try { const r = await api('me'); me = r.me; ME = me; } catch {}
  m.innerHTML = `<h2 class="section-title">My Profile</h2>
    <div class="glass form-card">
      <div class="center-text" style="margin-bottom:16px"><div class="av gold" style="width:64px;height:64px;font-size:1.4rem;margin:0 auto 10px">${initials(me.name)}</div><span class="badge ${me.role === 'admin' ? 'gold' : 'blue'}">${esc(me.role)}</span></div>
      <label>Full name</label><input id="p-name" value="${esc(me.name)}">
      <label>Phone</label><input id="p-phone" value="${esc(me.phone || '')}">
      <label>Email (verified)</label><input value="${esc(me.email)}" disabled>
      <label>Roll number</label><input value="${esc(me.roll)}" disabled>
      <div class="err" id="p-err"></div>
      <button style="width:100%" id="p-save">Save changes</button>
      <button class="ghost" style="width:100%;margin-top:10px" id="p-logout">Log out</button>
    </div>`;
  $('#p-save').addEventListener('click', async () => {
    try { const r = await api('profile', { name: $('#p-name').value, phone: $('#p-phone').value }); ME = r.me; localStorage.cc_me = JSON.stringify(ME); renderNav(); toast('Profile updated.', 'ok'); }
    catch (e) { $('#p-err').textContent = e.message; }
  });
  $('#p-logout').addEventListener('click', logout);
}

/* ---- admin --------------------------------------------------------------- */
async function renderAdmin(m) {
  loading(m);
  let stats;
  try { stats = await api('admin/stats'); } catch (e) { m.innerHTML = empty(e.message, '⚠'); return; }
  m.innerHTML = `<h2 class="section-title">Admin Dashboard</h2>
    <div class="admin-stats">${[['Users', stats.users], ['Banned', stats.banned], ['Cases', stats.cases], ['Live', stats.live], ['Resource disputes', stats.resourceDisputes], ['Pending invites', stats.pendingInvites]].map(([l, n]) => `<div class="glass admin-stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
    <div class="admin-tabs"><button class="ghost active" data-atab="users">Users</button><button class="ghost" data-atab="cases">Cases</button><button class="ghost" data-atab="invitations">Invitations</button><button class="ghost" data-atab="moderation">Moderation log</button></div>
    <div id="admin-body"></div>`;
  $$('.admin-tabs button', m).forEach((b) => b.addEventListener('click', () => { $$('.admin-tabs button', m).forEach((x) => x.classList.toggle('active', x === b)); adminTab(b.dataset.atab); }));
  adminTab('users');
}
async function adminTab(tab) {
  const el = $('#admin-body'); loading(el);
  try {
    if (tab === 'users') {
      const users = await api('admin/users');
      el.innerHTML = `<div class="glass table-scroll" style="padding:8px"><table class="data-table"><thead><tr><th>Name</th><th>Roll</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.roll)}</td><td>${esc(u.email)}</td><td><span class="badge ${u.role === 'admin' ? 'gold' : 'blue'}">${esc(u.role)}</span></td><td>${u.status === 'banned' ? `<span class="badge red">banned</span><div class="muted small">${u.ban && u.ban.until ? 'until ' + new Date(u.ban.until).toLocaleString() : 'permanent'}</div>` : '<span class="badge green">active</span>'}</td><td>${u.role === 'admin' ? '—' : u.status === 'banned' ? `<button class="sm ghost" data-unban="${u.id}">Unban</button>` : `<button class="sm red" data-ban="${u.id}" data-name="${esc(u.name)}">Ban</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      $$('[data-ban]', el).forEach((b) => b.addEventListener('click', () => banModal(b.dataset.ban, b.dataset.name)));
      $$('[data-unban]', el).forEach((b) => b.addEventListener('click', async () => { try { await api(`admin/users/${b.dataset.unban}/unban`, {}); toast('User unbanned.', 'ok'); adminTab('users'); } catch (e) { toast(e.message, 'err'); } }));
    } else if (tab === 'cases') {
      const cases = await api('admin/cases');
      el.innerHTML = `<div class="bento">${cases.map(card).join('')}</div>`; wireCards(el);
    } else if (tab === 'invitations') {
      const invs = await api('admin/invitations');
      el.innerHTML = invs.length ? `<div class="glass table-scroll" style="padding:8px"><table class="data-table"><thead><tr><th>Case</th><th>Kind</th><th>Target</th><th>Status</th><th>Expires</th></tr></thead><tbody>${invs.map((i) => `<tr><td>${esc(i.caseTitle || i.caseId)}</td><td>${esc(i.kind)}</td><td>${esc(i.email || i.targetRoll || '—')}</td><td><span class="badge ${i.status === 'pending' ? 'gold' : i.status === 'accepted' ? 'green' : 'red'}">${esc(i.status)}</span></td><td class="small">${new Date(i.expires).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : empty('No invitations yet.', '✉');
    } else {
      const log = await api('admin/moderation');
      el.innerHTML = log.length ? `<div class="glass table-scroll" style="padding:8px"><table class="data-table"><thead><tr><th>When</th><th>Action</th><th>Target</th><th>By</th><th>Reason</th></tr></thead><tbody>${log.map((m) => `<tr><td class="small">${new Date(m.at).toLocaleString()}</td><td><span class="badge">${esc(m.action)}</span></td><td>${esc(m.targetName || '—')}</td><td>${esc(m.by)}</td><td class="small">${esc(m.reason)}</td></tr>`).join('')}</tbody></table></div>` : empty('No moderation history yet.', '📜');
    }
  } catch (e) { el.innerHTML = empty(e.message, '⚠'); }
}
function banModal(userId, name) {
  modal(`<h3>Ban ${esc(name)}</h3><p class="muted small">Choose a temporary or permanent ban.</p>
    <label>Duration</label><select id="ban-hours"><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option><option value="">Permanent</option></select>
    <label>Reason</label><input id="ban-reason" placeholder="Reason for the ban">
    <div class="err" id="ban-err"></div>
    <button class="red" style="width:100%" id="ban-confirm">Confirm ban</button>
    <button class="ghost" style="width:100%;margin-top:8px" id="ban-cancel">Cancel</button>`);
  $('#ban-cancel').addEventListener('click', closeModal);
  $('#ban-confirm').addEventListener('click', async () => {
    const hours = $('#ban-hours').value; const body = { reason: $('#ban-reason').value }; if (hours) body.hours = +hours;
    try { await api(`admin/users/${userId}/ban`, body); closeModal(); toast('User banned.', 'ok'); renderAdmin($('#main')); }
    catch (e) { $('#ban-err').textContent = e.message; }
  });
}

/* ---- subtle 3D tilt (respects reduced motion) ---------------------------- */
if (!reduced) {
  document.addEventListener('mousemove', (e) => {
    const card = $('.auth-card'); if (!card || !$('#auth').classList.contains('on')) return;
    const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
    card.style.transform = `perspective(900px) rotateY(${x * 5}deg) rotateX(${-y * 5}deg)`;
  });
}

/* ---- start --------------------------------------------------------------- */
if (pendingInvite) boot();
else if (!localStorage.cc_intro_seen && !reduced) playIntro();
else boot();