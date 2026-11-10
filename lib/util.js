'use strict';
// Shared helpers. No external dependencies — Node built-ins only.
const crypto = require('crypto');

const now = () => Date.now();
const uid = () => crypto.randomBytes(5).toString('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Password hashing with scrypt (built-in, no bcrypt dependency).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === calc.length && crypto.timingSafeEqual(known, calc);
}

// Constant-time string compare for tokens.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const normEmail = (s) => String(s || '').trim().toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

// Local calendar day key, e.g. "2026-11-10" — used for the 2-cases/day limit.
function dayKey(ts = now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Escape user text before inserting into HTML (defense-in-depth; frontend also escapes).
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = {
  now, uid, token, sha256, clamp,
  hashPassword, verifyPassword, safeEqual,
  isEmail, normEmail, digits, dayKey, esc,
};