'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, buildCheckoutSession, orderSummary, CHECKOUT_SOON } = require('../server.js');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, body, path = '/api/checkout') =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

function stubStripe() {
  const calls = [];
  return {
    calls,
    checkout: {
      sessions: {
        async create(params) {
          calls.push(params);
          return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
        },
      },
    },
    webhooks: {
      constructEvent(body, sig, secret) {
        if (sig !== 'good' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
}

test('/health responds ok', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
});

test('checkout without a Stripe key returns the friendly "opens soon" message', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await post(base, { items: [{ flavor: 'blue-razz', qty: 2 }] });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.code, 'checkout_unavailable');
    assert.equal(j.message, CHECKOUT_SOON);
    assert.match(j.message, /Checkout opens soon/);

    const c = await (await fetch(base + '/api/config')).json();
    assert.equal(c.checkoutEnabled, false);
    assert.match(c.checkoutMessage, /Checkout opens soon/);
  });
});

test('checkout rejects bad input with 400', async () => {
  await withServer(createApp({ stripe: stubStripe(), logger: quiet }), async (base) => {
    const bodies = [
      {},
      { items: [] },
      { items: [{ flavor: 'grape', qty: 1 }] },
      { items: [{ flavor: 'blue-razz', qty: 0 }] },
      { items: [{ flavor: 'blue-razz', qty: 101 }] },
      { items: [{ flavor: 'blue-razz', qty: 2.5 }] },
      { items: [{ flavor: 'blue-razz', qty: '3' }] },
      { items: [{ flavor: 'blue-razz', qty: 1, unitCents: 1 }, { flavor: 'blue-razz', qty: 1 }] },
      '{not json',
    ];
    for (const b of bodies) {
      const r = await post(base, b);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(b)}`);
      assert.equal((await r.json()).ok, false);
    }
  });
});

test('client-sent prices are ignored; server computes the tier', async () => {
  const stripe = stubStripe();
  await withServer(createApp({ stripe, publicUrl: 'https://hellagood.example', logger: quiet }), async (base) => {
    const r = await post(base, { items: [{ flavor: 'blue-razz', qty: 3, price: 1, unitCents: 1 }, { flavor: 'orange-pineapple-mango', qty: 2 }], total: 1 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.equal(j.quote.totalCents, 5 * 539 + 799);
    assert.equal(stripe.calls.length, 1);
    assert.deepEqual(stripe.calls[0].line_items.map((l) => l.price_data.unit_amount), [539, 539]);
  });
});

test('Checkout Session payload (stubbed Stripe client)', async () => {
  const stripe = stubStripe();
  await withServer(createApp({ stripe, publicUrl: 'https://hellagood.example/', logger: quiet }), async (base) => {
    const r = await post(base, {
      items: [
        { flavor: 'blue-razz', qty: 6 },
        { flavor: 'strawberry-lemonade', qty: 5 },
        { flavor: 'orange-pineapple-mango', qty: 4 },
      ],
    });
    assert.equal(r.status, 200);
  });
  const s = stripe.calls[0];
  assert.equal(s.mode, 'payment');
  assert.equal(s.line_items.length, 3);
  for (const li of s.line_items) {
    assert.equal(li.price_data.currency, 'usd');
    assert.equal(li.price_data.unit_amount, 479);
    assert.match(li.price_data.product_data.name, /^HELLA GOOD! Energy Gummies: /);
    assert.match(li.price_data.product_data.description, /20% off/);
    assert.match(li.price_data.product_data.description, /\$5\.99 → \$4\.79/);
    assert.match(li.price_data.product_data.images[0], /^https:\/\/hellagood\.example\/images\/pack-.+\.webp$/);
  }
  assert.deepEqual(s.line_items.map((l) => l.quantity), [6, 5, 4]);
  assert.deepEqual(s.shipping_address_collection, { allowed_countries: ['US'] });
  assert.equal(s.shipping_options.length, 1);
  assert.deepEqual(s.shipping_options[0].shipping_rate_data.fixed_amount, { amount: 799, currency: 'usd' });
  assert.equal(s.shipping_options[0].shipping_rate_data.type, 'fixed_amount');
  assert.deepEqual(s.phone_number_collection, { enabled: true });
  assert.equal(s.success_url, 'https://hellagood.example/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(s.cancel_url, 'https://hellagood.example/cancel');
  assert.equal(s.metadata.items, 'blue-razz:6,strawberry-lemonade:5,orange-pineapple-mango:4');
  assert.equal(s.metadata.percent_off, '20');
});

test('no-discount line description and no images on non-https base', () => {
  const s = buildCheckoutSession([{ flavor: 'blue-razz', qty: 1 }], 'http://localhost:3000');
  const pd = s.line_items[0].price_data.product_data;
  assert.equal(s.line_items[0].price_data.unit_amount, 599);
  assert.match(pd.description, /\$5\.99 per pack/);
  assert.equal(pd.images, undefined);

  const ten = buildCheckoutSession([{ flavor: 'blue-razz', qty: 5 }], 'https://x.test');
  assert.match(ten.line_items[0].price_data.product_data.description, /Mix & match 5\+ packs: 10% off/);
});

test('Stripe errors surface as a friendly 502', async () => {
  const stripe = stubStripe();
  stripe.checkout.sessions.create = async () => { throw new Error('boom'); };
  await withServer(createApp({ stripe, logger: quiet }), async (base) => {
    const r = await post(base, { items: [{ flavor: 'blue-razz', qty: 1 }] });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /try again/);
  });
});

test('webhook verifies signatures and logs paid orders without card data', async () => {
  const logged = [];
  const logger = { ...quiet, info: (...a) => logged.push(a.join(' ')) };
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_paid',
        payment_status: 'paid',
        amount_total: 3494,
        metadata: { items: 'blue-razz:5', total_packs: '5' },
        customer_details: { email: 'buyer@example.com', phone: '+15555550100' },
        collected_information: { shipping_details: { name: 'Beast Mode', address: { city: 'Oakland', state: 'CA', line1: '1 Main St' } } },
      },
    },
  };
  await withServer(createApp({ stripe: stubStripe(), webhookSecret: 'whsec_test', logger }), async (base) => {
    const bad = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'nope' }, body: JSON.stringify(event) });
    assert.equal(bad.status, 400);
    const good = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'good' }, body: JSON.stringify(event) });
    assert.equal(good.status, 200);
  });
  const orders = logged.filter((l) => l.startsWith('[order paid]'));
  assert.equal(orders.length, 1);
  assert.match(orders[0], /cs_test_paid/);
  assert.match(orders[0], /blue-razz:5/);
  assert.match(orders[0], /\$34\.94/);
  assert.match(orders[0], /Beast Mode/);
  assert.match(orders[0], /Oakland, CA/);
  assert.doesNotMatch(orders[0], /1 Main St|buyer@example|5555550100/);
  // The request log lines for the two webhook calls carry no customer data either.
  assert.deepEqual(logged.filter((l) => l.startsWith('[req]')).map((l) => l.replace(/ \d+ms$/, '')), ['[req] POST /api/stripe/webhook 400', '[req] POST /api/stripe/webhook 200']);

  const legacy = orderSummary({ id: 'x', amount_total: 100, shipping_details: { name: 'A', address: { city: 'Seattle', state: 'WA' } } });
  assert.equal(legacy.shipCity, 'Seattle, WA');
});

test('webhook is disabled cleanly when not configured', async () => {
  await withServer(createApp({ stripe: null, webhookSecret: undefined, logger: quiet }), async (base) => {
    const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
  });
});

test('security headers: CSP allows Stripe, fonts are self-hosted', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/js\.stripe\.com/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /font-src 'self';/);
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    assert.doesNotMatch(await r.text(), /fonts\.googleapis|fonts\.gstatic/, 'no third-party font requests');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-content-type-options'));
  });
});

test('checkout route is rate limited', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    let last;
    for (let i = 0; i < 21; i++) last = await post(base, { items: [{ flavor: 'blue-razz', qty: 1 }] });
    assert.equal(last.status, 429);
  });
});

test('source pages are not served', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    for (const p of ['/source-pages/page1.png', '/page1.png', '/../source-pages/page2.webp']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, p);
    }
  });
});
