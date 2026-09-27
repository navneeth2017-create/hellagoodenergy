'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const ORIGIN = 'https://hellagood.example';

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

const get = (base, p, init) => fetch(base + p, { redirect: 'manual', ...init });

/** A stub Stripe client whose Checkout Session can be read back for /success. */
function stubStripe(session) {
  const retrieved = [];
  return {
    retrieved,
    checkout: {
      sessions: {
        async create() {
          return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
        },
        async retrieve(id, params) {
          retrieved.push({ id, params });
          if (!session) throw new Error('No such checkout.session');
          return { id, ...session };
        },
      },
    },
    webhooks: { constructEvent() { throw new Error('unused'); } },
  };
}

function jsonLd(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'JSON-LD block present');
  return JSON.parse(m[1]);
}

test('robots.txt allows the site, blocks the API and points at the sitemap', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/robots.txt');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    const body = await r.text();
    assert.match(body, /^User-agent: \*$/m);
    assert.match(body, /^Disallow: \/api\/$/m);
    assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
  });
});

test('sitemap.xml lists the canonical home page and skips drafts and checkout pages', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN + '/', logger: quiet }), async (base) => {
    const r = await get(base, '/sitemap.xml');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    const xml = await r.text();
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.ok(xml.includes(`<loc>${ORIGIN}/</loc>`));
    for (const p of ['/success', '/cancel', '/privacy', '/terms']) assert.ok(!xml.includes(`<loc>${ORIGIN}${p}</loc>`), p);
  });
});

test('canonical and Open Graph URLs fall back to the request origin without PUBLIC_URL', async () => {
  const prev = process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  try {
    await withServer(createApp({ stripe: null, publicUrl: undefined, logger: quiet }), async (base) => {
      const html = await (await get(base, '/')).text();
      assert.ok(html.includes(`<link rel="canonical" href="${base}/">`));
      assert.match(html, new RegExp(`<meta property="og:image" content="${base}/images/og-image\\.jpg\\?v=[0-9a-f]{10}">`));
      assert.match(await (await get(base, '/robots.txt')).text(), new RegExp(`Sitemap: ${base}/sitemap\\.xml`));
    });
  } finally {
    if (prev !== undefined) process.env.RAILWAY_PUBLIC_DOMAIN = prev;
  }
});

test('home page: SEO, sharing and icon tags, versioned assets', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const html = await r.text();
    assert.match(html, /<title>[^<]*HELLA GOOD! Energy Gummies[^<]*<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]{80,170}">/);
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/">`));
    for (const tag of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
      assert.match(html, new RegExp(`<meta property="${tag}" content="[^"]+">`), tag);
    }
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg\?v=[0-9a-f]{10}" type="image\/svg\+xml">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png\?v=[0-9a-f]{10}">/);
    assert.match(html, /<link rel="preload" as="image" type="image\/avif" href="\/images\/hero-marshawn\.avif\?v=[0-9a-f]{10}"/);
    assert.match(html, /<link rel="preload" href="\/fonts\/barlow-condensed-v13-900-italic\.woff2" as="font" type="font\/woff2" crossorigin>/);
    assert.match(html, /<link rel="stylesheet" href="\/css\/styles\.css\?v=[0-9a-f]{10}">/);
    assert.match(html, /<script src="\/js\/app\.js\?v=[0-9a-f]{10}" defer><\/script>/);
    assert.doesNotMatch(html, /<!--#include|\{\{[A-Z]+\}\}/, 'no template syntax leaks');
    assert.doesNotMatch(html, /name="robots"/, 'home is indexable');
    assert.ok(html.includes('[TODO Nav: daily max]'), 'daily max still flagged');
    for (const gone of ['processing time', 'returns and refunds policy', 'support email or phone']) assert.ok(!html.includes(gone), gone);
    assert.ok(html.includes('arrives within 7 days') && html.includes('unopened products within 30 days') && html.includes('admin@hellagoodenergy.com'));
    assert.ok(html.includes('href="/privacy"') && html.includes('href="/terms"'), 'footer links to the policies');
  });
});

test('JSON-LD: Organization and a $5.99 USD Product per flavor, PreOrder while checkout is off', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const data = jsonLd(await (await get(base, '/')).text());
    assert.equal(data['@context'], 'https://schema.org');
    const org = data['@graph'].find((n) => n['@type'] === 'Organization');
    assert.equal(org.name, 'Hella Good Energy');
    assert.equal(org.url, `${ORIGIN}/`);
    const products = data['@graph'].filter((n) => n['@type'] === 'Product');
    assert.deepEqual(products.map((p) => p.sku), ['blue-razz', 'strawberry-lemonade', 'orange-pineapple-mango']);
    for (const p of products) {
      assert.equal(p.offers['@type'], 'Offer');
      assert.equal(p.offers.price, '5.99');
      assert.equal(p.offers.priceCurrency, 'USD');
      assert.equal(p.offers.availability, 'https://schema.org/PreOrder');
      assert.ok(p.image.startsWith(`${ORIGIN}/images/pack-`));
    }
  });
});

test('JSON-LD: InStock once checkout is enabled', async () => {
  await withServer(createApp({ stripe: stubStripe(null), publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const products = jsonLd(await (await get(base, '/')).text())['@graph'].filter((n) => n['@type'] === 'Product');
    assert.equal(products.length, 3);
    for (const p of products) {
      assert.equal(p.offers.price, '5.99');
      assert.equal(p.offers.availability, 'https://schema.org/InStock');
    }
  });
});

for (const [route, heading] of [['/privacy', /Privacy <em>Policy<\/em>/], ['/terms', /Terms of <em>Sale<\/em>/]]) {
  test(`${route} is a draft page with the review banner, placeholders and the site chrome`, async () => {
    await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
      const r = await get(base, route);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/html/);
      const html = await r.text();
      assert.match(html, heading);
      assert.ok(html.includes('Draft</strong> &mdash; Nav to review before launch'));
      assert.match(html, /<meta name="robots" content="noindex">/, 'drafts stay out of search');
      assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${route}">`));
      assert.ok(html.includes('RCFML Gummies LLC'));
      assert.ok(html.includes('[Street address, City, State ZIP]'));
      assert.ok(html.includes('mailto:admin@hellagoodenergy.com'));
      assert.ok(!html.includes('[Support email]') && !html.includes('[Support phone]'));
      assert.ok(html.includes('Stripe'));
      assert.match(html, /<footer class="site-footer">/);
      assert.doesNotMatch(html, /<!--#include|\{\{[A-Z]+\}\}/);
    });
    // The raw template is never served; the .html URL redirects to the clean one.
    await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
      const r = await get(base, route + '.html');
      assert.equal(r.status, 301);
      assert.equal(r.headers.get('location'), route);
    });
  });
}

test('/success without a Stripe key: generic thank-you, noindex, clears the cart', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Thank <em>you!<\/em>/);
    assert.match(html, /Order received/);
    assert.doesNotMatch(html, /Order summary/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<body class="page-status" data-page="success">/);
    assert.match(html, /\/js\/pages\.js\?v=/);
  });
});

test('/success with a key and a session id shows the order summary', async () => {
  const stripe = stubStripe({
    payment_status: 'paid',
    amount_subtotal: 2695,
    amount_total: 3494,
    total_details: { amount_shipping: 799, amount_tax: 0 },
    metadata: { percent_off: '10' },
    line_items: {
      data: [
        { description: 'HELLA GOOD! Energy Gummies: Blue Razz', quantity: 3, amount_total: 1617 },
        { description: 'HELLA GOOD! Energy Gummies: <b>Orange</b> Pineapple Mango', quantity: 2, amount_total: 1078 },
      ],
    },
  });
  await withServer(createApp({ stripe, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8')).text();
    assert.equal(stripe.retrieved.length, 1);
    assert.equal(stripe.retrieved[0].id, 'cs_test_a1B2c3D4e5F6g7H8');
    assert.deepEqual(stripe.retrieved[0].params, { expand: ['line_items'] });
    assert.match(html, /Order confirmed/);
    assert.match(html, /Order summary/);
    assert.match(html, /Blue Razz/);
    assert.match(html, /3 &times; \$5\.39/);
    assert.match(html, /\$16\.17/);
    assert.match(html, /Mix &amp; match 10% off/);
    assert.match(html, /<dt>Shipping<\/dt><dd>\$7\.99<\/dd>/);
    assert.match(html, /<dt>Total<\/dt><dd>\$34\.94<\/dd>/);
    assert.match(html, /Ref &hellip;e5F6g7H8/);
    assert.ok(html.includes('&lt;b&gt;Orange&lt;/b&gt;'), 'Stripe data is HTML-escaped');
  });
});

test('/success ignores malformed session ids and survives Stripe errors', async () => {
  const stripe = stubStripe(null); // retrieve throws
  await withServer(createApp({ stripe, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    for (const q of ['', '?session_id=nope', '?session_id=cs_test_%3Cscript%3E', '?session_id=cs_test_a1B2c3D4e5F6g7H8']) {
      const r = await get(base, '/success' + q);
      assert.equal(r.status, 200, q);
      const html = await r.text();
      assert.match(html, /Order received/);
      assert.doesNotMatch(html, /<script>/);
    }
    assert.equal(stripe.retrieved.length, 1, 'only the well-formed id reaches Stripe');
  });
});

test('/cancel links back to the cart and old Stripe return URLs redirect', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/cancel');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Checkout cancelled/);
    assert.match(html, /Your cart is saved/);
    assert.match(html, /href="\/#cart"/);
    assert.match(html, /<meta name="robots" content="noindex">/);

    const oldCancel = await get(base, '/?checkout=cancelled');
    assert.equal(oldCancel.status, 302);
    assert.equal(oldCancel.headers.get('location'), '/cancel');
    const oldSuccess = await get(base, '/?checkout=success&session_id=cs_test_a1B2c3D4e5F6g7H8');
    assert.equal(oldSuccess.status, 302);
    assert.equal(oldSuccess.headers.get('location'), '/success?session_id=cs_test_a1B2c3D4e5F6g7H8');
  });
});

test('404 page is branded, noindex and returns 404', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    for (const p of ['/nope', '/partials/footer.html', '/index.htm/x']) {
      const r = await get(base, p);
      assert.equal(r.status, 404, p);
      const html = await r.text();
      assert.match(html, /ran out of <em>energy<\/em>/);
      assert.match(html, /<meta name="robots" content="noindex">/);
      assert.doesNotMatch(html, /<!--#include/);
    }
  });
});

test('static assets: a year of caching when versioned, shorter otherwise; gzip stays on', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const css = html.match(/\/css\/styles\.css\?v=[0-9a-f]{10}/)[0];
    const v = await get(base, css, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(v.status, 200);
    assert.equal(v.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(v.headers.get('content-encoding'), 'gzip');
    const plain = await get(base, '/css/styles.css');
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=3600');
    for (const p of ['/images/og-image.jpg', '/apple-touch-icon.png', '/favicon.ico', '/favicon.svg']) {
      const r = await get(base, p);
      assert.equal(r.status, 200, p);
    }
  });
});
