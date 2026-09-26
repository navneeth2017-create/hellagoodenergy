'use strict';
// Stripe keys pasted into Railway: only a real secret key turns checkout on. Empty, placeholder, publishable
// or quoted-wrong values leave the store on "Checkout opens soon", and nothing ever logs the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSecretKey, cleanWebhookSecret, keyStatus, makeStripe } = require('../server');

const LIVE = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0';
const TEST = 'sk_test_' + 'Z9y8X7w6V5u4';

test('empty, blank and placeholder values count as not set', () => {
  for (const v of [undefined, null, '', '   ', 'PASTE_KEY_HERE', 'your-key', 'sk_live_', 'sk_live_ has spaces']) {
    assert.equal(cleanSecretKey(v), '', JSON.stringify(v));
    assert.equal(makeStripe(v), null, JSON.stringify(v));
  }
});

test('a publishable key or webhook secret in the secret box is refused', () => {
  for (const v of ['pk_live_abc123', 'pk_test_abc123', 'whsec_abc123']) assert.equal(cleanSecretKey(v), '', v);
  assert.match(keyStatus('pk_live_abc123'), /not a Stripe secret key/);
  assert.doesNotMatch(keyStatus('pk_live_abc123'), /pk_live_abc123/, 'the log never repeats the value');
});

test('real secret and restricted keys are accepted, trimmed and unquoted', () => {
  assert.equal(cleanSecretKey(LIVE), LIVE);
  assert.equal(cleanSecretKey(`  ${LIVE}\n`), LIVE);
  assert.equal(cleanSecretKey(`"${LIVE}"`), LIVE);
  assert.equal(cleanSecretKey('rk_live_Q1w2E3'), 'rk_live_Q1w2E3');
  assert.equal(cleanSecretKey(TEST), TEST);
  assert.ok(makeStripe(LIVE), 'a client is made for a real key');
  assert.match(keyStatus(LIVE), /ON \(live mode\)/);
  assert.match(keyStatus(TEST), /ON \(TEST mode\)/);
  assert.doesNotMatch(keyStatus(LIVE), /a1B2c3/, 'the log never contains the key');
  assert.match(keyStatus(''), /not set/);
});

test('webhook secret must look like whsec_', () => {
  assert.equal(cleanWebhookSecret(''), '');
  assert.equal(cleanWebhookSecret('sk_live_abc'), '');
  assert.equal(cleanWebhookSecret(' whsec_Abc123 '), 'whsec_Abc123');
});
