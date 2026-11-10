'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Hermetic environment: temp DB, demo on (invite links returned), no mail/AI keys.
const TMP = path.join(os.tmpdir(), `cc_it_${Date.now()}_${process.pid}.json`);
process.env.DB_FILE = TMP;
process.env.DEMO = '1';
delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
delete process.env.GEMINI_KEYS; delete process.env.GROQ_KEYS;

const { createServer } = require('../server');
const db = require('../lib/db');
const U = require('../lib/util');

test('API integration', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  t.after(() => { server.close(); try { fs.unlinkSync(TMP); } catch {} });

  // Use Node's http with agent:false (fresh socket per request) for deterministic
  // responses — avoids fetch/undici connection-pool response mismatching.
  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    }, (res) => {
      let raw = ''; res.on('data', (c) => raw += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const reg = (roll, email) => req('POST', '/api/register', { body: { name: 'User ' + roll, roll, email, password: 'secret123', phone: '0300' } });

  let aliceTok, aliceId; const aliceRoll = '21CS-100';
  let adminTok;

  await t.test('health', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.schema, 2);
  });

  await t.test('registration validation + duplicate protection', async () => {
    let r = await reg(aliceRoll, 'alice@x.com');
    assert.equal(r.status, 200); assert.equal(r.body.me.role, 'user'); aliceTok = r.body.token; aliceId = r.body.me.id;
    assert.equal((await reg('21CS-101', 'alice@x.com')).status, 409); // dup email
    assert.equal((await reg(aliceRoll, 'other@x.com')).status, 409);  // dup roll
    assert.equal((await req('POST', '/api/register', { body: { name: 'Bad', roll: '21CS-102', email: 'bad', password: 'secret123' } })).status, 400);
    assert.equal((await req('POST', '/api/register', { body: { name: 'Bad', roll: '21CS-103', email: 'ok@x.com', password: '123' } })).status, 400);
  });

  await t.test('login', async () => {
    assert.equal((await req('POST', '/api/login', { body: { email: 'alice@x.com', password: 'wrong' } })).status, 401);
    const r = await req('POST', '/api/login', { body: { email: 'alice@x.com', password: 'secret123' } });
    assert.equal(r.status, 200); assert.ok(r.body.token);
  });

  await t.test('auth required + no self-promotion', async () => {
    assert.equal((await req('GET', '/api/feed')).status, 401);
    const r = await req('POST', '/api/profile', { token: aliceTok, body: { name: 'Alice Updated', role: 'admin' } });
    assert.equal(r.status, 200); assert.equal(r.body.me.role, 'user'); // role ignored
  });

  await t.test('admin protection, ban/unban, moderation log', async () => {
    assert.equal((await req('GET', '/api/admin/users', { token: aliceTok })).status, 403);
    const login = await req('POST', '/api/login', { body: { email: 'haroonsheik0127@gmail.com', password: 'admin1234' } });
    assert.equal(login.status, 200); assert.equal(login.body.me.role, 'admin'); adminTok = login.body.token;
    assert.equal((await req('POST', `/api/admin/users/${aliceId}/ban`, { token: aliceTok, body: { hours: 24 } })).status, 403);
    let r = await req('POST', `/api/admin/users/${aliceId}/ban`, { token: adminTok, body: { hours: 24, reason: 'spam' } });
    assert.equal(r.status, 200); assert.equal(r.body.user.status, 'banned'); assert.ok(r.body.user.ban.until);
    r = await req('GET', '/api/feed', { token: aliceTok }); assert.equal(r.status, 403); assert.equal(r.body.banned, true);
    assert.equal((await req('POST', '/api/login', { body: { email: 'alice@x.com', password: 'secret123' } })).status, 403);
    const adminRec = db.getDB().students.find((s) => s.role === 'admin');
    assert.equal((await req('POST', `/api/admin/users/${adminRec.id}/ban`, { token: adminTok, body: {} })).status, 400);
    r = await req('GET', '/api/admin/moderation', { token: adminTok }); assert.ok(r.body.some((m) => m.action === 'temp-ban' && m.targetId === aliceId));
    r = await req('POST', `/api/admin/users/${aliceId}/unban`, { token: adminTok }); assert.equal(r.status, 200); assert.equal(r.body.user.status, 'active');
    assert.equal((await req('GET', '/api/feed', { token: aliceTok })).status, 200);
  });

  await t.test('temporary ban auto-expires', async () => {
    const r = await reg('22CS-200', 'bob@x.com'); const bobTok = r.body.token; const bobId = r.body.me.id;
    await req('POST', `/api/admin/users/${bobId}/ban`, { token: adminTok, body: { hours: 24, reason: 'temp' } });
    db.userById(bobId).ban.until = Date.now() - 1000; // simulate 24h passing
    await req('GET', '/api/feed', { token: adminTok }); // triggers sweep
    const bob = db.userById(bobId); assert.equal(bob.status, 'active'); assert.equal(bob.ban, null);
    assert.equal((await req('GET', '/api/feed', { token: bobTok })).status, 200);
    const log = await req('GET', '/api/admin/moderation', { token: adminTok });
    assert.ok(log.body.some((m) => m.action === 'auto-unban' && m.targetId === bobId));
  });

  await t.test('two-cases-per-day limit enforced server-side', async () => {
    const r = await reg('22CS-300', 'carol@x.com'); const carolTok = r.body.token;
    assert.equal((await req('POST', '/api/cases', { token: carolTok, body: { accusedRoll: '21CS-027', title: 'C1', details: 'd' } })).status, 200);
    assert.equal((await req('POST', '/api/cases', { token: carolTok, body: { accusedRoll: '22EE-009', title: 'C2', details: 'd' } })).status, 200);
    assert.equal((await req('POST', '/api/cases', { token: carolTok, body: { accusedRoll: '21CS-027', title: 'C3', details: 'd' } })).status, 429);
    assert.equal((await req('GET', '/api/me', { token: carolTok })).body.filedToday, 2);
  });

  await t.test('registered in-app invitation + accept + reuse blocked', async () => {
    const r = await reg('22CS-400', 'dave@x.com'); const daveTok = r.body.token;
    let c = await req('POST', '/api/cases', { token: daveTok, body: { accusedRoll: aliceRoll, title: 'In-app invite', details: 'd' } });
    assert.equal(c.status, 200); assert.equal(c.body.kind, 'registered'); const caseId = c.body.id;
    const mine = await req('GET', '/api/mine', { token: aliceTok });
    const inv = mine.body.invitations.find((i) => i.caseId === caseId); assert.ok(inv);
    let a = await req('POST', '/api/invitations/accept', { token: aliceTok, body: { id: inv.id } });
    assert.equal(a.status, 200); assert.equal(a.body.joined, true);
    const cs = await req('GET', '/api/cases/' + caseId, { token: aliceTok });
    assert.equal(cs.body.status, 'live'); assert.equal(cs.body.you, 'accused');
    assert.equal((await req('POST', '/api/invitations/accept', { token: aliceTok, body: { id: inv.id } })).status, 400);
  });

  await t.test('external email invitation: secure token, join, reuse + expiry blocked', async () => {
    const daveLogin = await req('POST', '/api/login', { body: { email: 'dave@x.com', password: 'secret123' } });
    const daveTok = daveLogin.body.token;
    let c = await req('POST', '/api/cases', { token: daveTok, body: { accusedEmail: 'external@x.com', title: 'External summons', details: 'd' } });
    assert.equal(c.status, 200); assert.equal(c.body.kind, 'external'); assert.ok(c.body.inviteLink);
    const raw = new URL(c.body.inviteLink).searchParams.get('invite');
    const extCase = c.body.id;
    let p = await req('GET', `/api/invitations/${raw}/preview`); assert.equal(p.status, 200); assert.equal(p.body.caseTitle, 'External summons'); assert.equal(p.body.status, 'pending');
    const er = await reg('23CS-500', 'external@x.com'); const extTok = er.body.token;
    let a = await req('POST', '/api/invitations/accept', { token: extTok, body: { token: raw } });
    assert.equal(a.status, 200); assert.equal(a.body.caseId, extCase);
    const cs = await req('GET', '/api/cases/' + extCase, { token: extTok });
    assert.equal(cs.body.accused.roll, '23CS-500'); assert.equal(cs.body.status, 'live');
    assert.equal((await req('POST', '/api/invitations/accept', { token: extTok, body: { token: raw } })).status, 400); // reuse

    const fr = await reg('23CS-600', 'erin@x.com'); const erinTok = fr.body.token;
    c = await req('POST', '/api/cases', { token: erinTok, body: { accusedEmail: 'late@x.com', title: 'Expiring invite', details: 'd' } });
    const raw2 = new URL(c.body.inviteLink).searchParams.get('invite');
    db.getDB().invitations.find((i) => i.tokenHash === U.sha256(raw2)).expires = Date.now() - 1000; // simulate expiry
    const lr = await reg('23CS-700', 'late@x.com');
    const ax = await req('POST', '/api/invitations/accept', { token: lr.body.token, body: { token: raw2 } });
    assert.equal(ax.status, 400); assert.match(ax.body.error, /expired/i);
  });

  await t.test('resource dispute: deterministic allocation + fairness history', async () => {
    const a = await reg('24CS-001', 'resa@x.com'); const resaTok = a.body.token; const resaRoll = '24CS-001';
    await reg('24CS-002', 'resb@x.com'); const resbRoll = '24CS-002';
    await reg('24CS-003', 'resc@x.com'); const rescRoll = '24CS-003';
    const far = Date.now() + 200 * 3600e3;
    let c = await req('POST', '/api/resource', { token: resaTok, body: { title: 'Printer dispute 1', resource: { name: 'Printer X' }, claimants: [{ roll: resaRoll, urgency: 9, deadline: far, reason: 'a' }, { roll: resbRoll, urgency: 5, deadline: far, reason: 'b' }] } });
    assert.equal(c.status, 200); const rc1 = c.body.id;
    let r = await req('POST', `/api/cases/${rc1}/resolve`, { token: resaTok });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'decided'); assert.equal(r.body.allocation.allocation.winner, resaRoll);
    assert.ok(Array.isArray(r.body.allocation.table)); assert.ok(r.body.allocation.explanation.length > 20);

    c = await req('POST', '/api/resource', { token: resaTok, body: { title: 'Printer dispute 2', resource: { name: 'Printer X' }, claimants: [{ roll: resaRoll, urgency: 9, deadline: far, reason: 'a' }, { roll: rescRoll, urgency: 9, deadline: far, reason: 'c' }] } });
    assert.equal(c.status, 200); const rc2 = c.body.id;
    r = await req('POST', `/api/cases/${rc2}/resolve`, { token: resaTok });
    assert.equal(r.status, 200);
    const rowA = r.body.allocation.table.find((x) => x.roll === resaRoll);
    const rowC = r.body.allocation.table.find((x) => x.roll === rescRoll);
    assert.ok(rowA.fairness < rowC.fairness); // recent recipient deprioritised
    assert.equal(r.body.allocation.allocation.winner, rescRoll);
    const resource = db.getDB().resources.find((x) => x.name === 'Printer X');
    assert.ok(resource.allocations.length >= 2);
  });

  await t.test('resource claim submitted later, then resolved', async () => {
    const f = await reg('24CS-010', 'frank@x.com'); const frankTok = f.body.token; const frankRoll = '24CS-010';
    const g = await reg('24CS-011', 'grace@x.com'); const graceTok = g.body.token; const graceRoll = '24CS-011';
    const far = Date.now() + 200 * 3600e3;
    const c = await req('POST', '/api/resource', { token: frankTok, body: { title: 'Book dispute', resource: { name: 'Book Y' }, claimants: [{ roll: frankRoll, urgency: 7, deadline: far, reason: 'f' }, { roll: graceRoll }] } });
    const rc = c.body.id;
    assert.equal((await req('POST', `/api/cases/${rc}/resolve`, { token: frankTok })).status, 400); // only 1 submitted
    assert.equal((await req('POST', `/api/cases/${rc}/claim`, { token: graceTok, body: { urgency: 8, deadline: far, reason: 'g', resource: 'Book Y' } })).status, 200);
    const r = await req('POST', `/api/cases/${rc}/resolve`, { token: frankTok });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'decided');
    assert.equal((await req('POST', `/api/cases/${rc}/resolve`, { token: frankTok })).status, 200); // owner re-resolve is idempotent
    assert.equal((await req('POST', `/api/cases/${rc}/resolve`, { token: graceTok })).status, 403); // non-owner cannot resolve
  });

  await t.test('static serving + path traversal blocked', async () => {
    const r = await fetch(base + '/'); assert.equal(r.status, 200);
    const html = await r.text(); assert.match(html, /Campus Court/i);
    const trav = await fetch(base + '/%2e%2e/server.js'); assert.equal(trav.status, 404);
  });
});