'use strict';
// CAMPUS COURT — plain Node HTTP server (no web framework), JSON-file DB.
// Run: npm start  →  node server.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env (same lightweight parser as the original project).
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
  });
} catch { /* no .env — use defaults */ }

const db = require('./lib/db');
const api = require('./lib/api');
const mail = require('./lib/mail');
const ai = require('./lib/ai');
const E = process.env;
const PORT = +E.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(PUB, rel));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}

function createServer() {
  db.load();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      let raw = '';
      for await (const ch of req) { raw += ch; if (raw.length > 1e6) return send(413, { error: 'Request too large' }); }
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'Invalid JSON body' }); } }
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const [s, o] = await api.handle({ method: req.method, pathname: url.pathname, query: url.searchParams, body, token });
      return send(s, o);
    } catch (e) {
      console.log('[api:error]', e && e.message);
      return send(500, { error: 'Server error' });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`\n⚖️  CAMPUS COURT running → http://localhost:${PORT}`);
    console.log(`   Gemini keys: ${ai.keys('GEMINI_KEYS').length} | Groq keys: ${ai.keys('GROQ_KEYS').length} | Gmail: ${mail.enabled() ? 'ON' : 'dry-run'} | DEMO: ${E.DEMO !== '0'}`);
    console.log(`   Admin login: ${db.ADMIN_EMAIL} / admin1234   |   Demo student: 21cs014@example.com / court1234\n`);
  });
}

module.exports = { createServer };