'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/util');

test('password hashing: correct verifies, wrong/tampered do not', () => {
  const hash = U.hashPassword('secret123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(U.verifyPassword('secret123', hash), true);
  assert.equal(U.verifyPassword('wrong', hash), false);
  assert.equal(U.verifyPassword('secret123', 'scrypt$bad$bad'), false);
  assert.equal(U.verifyPassword('secret123', null), false);
  // two hashes of the same password differ (random salt)
  assert.notEqual(U.hashPassword('secret123'), hash);
});

test('email validation', () => {
  assert.equal(U.isEmail('a@b.com'), true);
  assert.equal(U.isEmail('first.last@uni.edu.pk'), true);
  assert.equal(U.isEmail('nope'), false);
  assert.equal(U.isEmail('a@b'), false);
  assert.equal(U.isEmail('a@b.c'), false); // TLD must be >= 2
  assert.equal(U.isEmail(''), false);
  assert.equal(U.normEmail('  MiXeD@X.COM '), 'mixed@x.com');
});

test('dayKey formats a local calendar day', () => {
  assert.match(U.dayKey(0), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(U.dayKey(1000), U.dayKey(1000));
});

test('safeEqual compares without throwing on length mismatch', () => {
  assert.equal(U.safeEqual('abc', 'abc'), true);
  assert.equal(U.safeEqual('abc', 'abcd'), false);
  assert.equal(U.safeEqual('abc', 'abd'), false);
});

test('esc neutralises HTML', () => {
  assert.equal(U.esc('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});