'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/js/pricing.js');

const cart = (...pairs) => pairs.map(([flavor, qty]) => ({ flavor, qty }));

test('tier unit prices are $5.99 / $5.39 / $4.79', () => {
  assert.equal(P.unitCentsFor(0), 599);
  assert.equal(P.unitCentsFor(10), 539);
  assert.equal(P.unitCentsFor(20), 479);
});

test('1 pack: full price + flat shipping', () => {
  const q = P.quote(cart(['blue-razz', 1]));
  assert.equal(q.tier.percentOff, 0);
  assert.equal(q.subtotalCents, 599);
  assert.equal(q.shippingCents, 799);
  assert.equal(q.totalCents, 1398);
  assert.equal(P.nudge(1), 'Add 4 more packs to save 10%.');
});

test('4 packs: still full price, 1 pack from 10%', () => {
  const q = P.quote(cart(['strawberry-lemonade', 4]));
  assert.equal(q.tier.percentOff, 0);
  assert.equal(q.subtotalCents, 4 * 599);
  assert.equal(q.totalCents, 4 * 599 + 799);
  assert.equal(P.nudge(4), 'Add 1 more pack to save 10%.');
});

test('5 packs: 10% off -> $5.39 each', () => {
  const q = P.quote(cart(['orange-pineapple-mango', 5]));
  assert.equal(q.tier.percentOff, 10);
  assert.equal(q.tier.unitCents, 539);
  assert.equal(q.subtotalCents, 2695);
  assert.equal(q.savingsCents, 300);
  assert.equal(q.totalCents, 2695 + 799);
  assert.equal(P.nudge(5), 'Add 10 more packs to save 20%.');
});

test('14 packs: still 10%', () => {
  const q = P.quote(cart(['blue-razz', 14]));
  assert.equal(q.tier.percentOff, 10);
  assert.equal(q.subtotalCents, 14 * 539);
  assert.equal(P.nudge(14), 'Add 1 more pack to save 20%.');
});

test('15 packs: 20% off -> $4.79 each', () => {
  const q = P.quote(cart(['blue-razz', 15]));
  assert.equal(q.tier.percentOff, 20);
  assert.equal(q.tier.unitCents, 479);
  assert.equal(q.subtotalCents, 7185);
  assert.equal(q.totalCents, 7185 + 799);
  assert.equal(P.nextTier(15), null);
  assert.match(P.nudge(15), /20%/);
});

test('mixed flavors count toward the tier together', () => {
  // 2 + 2 + 1 = 5 packs -> 10% on every line
  const five = P.quote(cart(['blue-razz', 2], ['strawberry-lemonade', 2], ['orange-pineapple-mango', 1]));
  assert.equal(five.totalPacks, 5);
  assert.equal(five.tier.percentOff, 10);
  assert.deepEqual(five.lines.map((l) => l.unitCents), [539, 539, 539]);
  assert.equal(five.subtotalCents, 2695);

  // 6 + 5 + 4 = 15 packs -> 20%
  const fifteen = P.quote(cart(['blue-razz', 6], ['strawberry-lemonade', 5], ['orange-pineapple-mango', 4]));
  assert.equal(fifteen.tier.percentOff, 20);
  assert.equal(fifteen.subtotalCents, 15 * 479);

  // 2 + 2 = 4 -> no discount
  const four = P.quote(cart(['blue-razz', 2], ['orange-pineapple-mango', 2]));
  assert.equal(four.tier.percentOff, 0);
});

test('validation rejects bad input', () => {
  const bad = [
    undefined,
    null,
    'blue-razz',
    [],
    {},
    [null],
    cart(['grape', 1]),
    cart(['blue-razz', 0]),
    cart(['blue-razz', -3]),
    cart(['blue-razz', 101]),
    cart(['blue-razz', 1.5]),
    cart(['blue-razz', '2']),
    cart(['blue-razz', NaN]),
    cart(['blue-razz', Infinity]),
    cart(['blue-razz', 1], ['blue-razz', 1]),
    [{ flavor: '__proto__', qty: 1 }],
    [{ flavor: 'blue-razz', qty: 1 }, { flavor: 'strawberry-lemonade', qty: 1 }, { flavor: 'orange-pineapple-mango', qty: 1 }, { flavor: 'blue-razz', qty: 1 }],
  ];
  for (const b of bad) assert.equal(P.validateItems(b).ok, false, `should reject ${JSON.stringify(b)}`);
});

test('validation accepts the 1-100 range per flavor', () => {
  assert.equal(P.validateItems(cart(['blue-razz', 1])).ok, true);
  assert.equal(P.validateItems(cart(['blue-razz', 100], ['strawberry-lemonade', 100], ['orange-pineapple-mango', 100])).ok, true);
});
