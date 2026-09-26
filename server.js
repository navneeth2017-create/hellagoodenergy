'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const pricing = require('./public/js/pricing.js');
const site = require('./lib/site.js');

const CHECKOUT_SOON = 'Checkout opens soon! Online ordering for HELLA GOOD! Energy Gummies is almost live. Your cart is saved.';

function makeStripe(secretKey) {
  if (!secretKey) return null;
  const Stripe = require('stripe');
  return new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: 'hellagoodgummies-storefront' } });
}

/** Where Stripe should send the shopper back to. PUBLIC_URL wins, then Railway's domain, then the request. */
function baseUrlFor(req, publicUrl) {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

function describeTier(tier) {
  const unit = pricing.formatCents(tier.unitCents);
  if (!tier.percentOff) return `${unit} per pack. Mix any 5+ packs to save 10%.`;
  return `Mix & match ${tier.minPacks}+ packs: ${tier.percentOff}% off (${pricing.formatCents(pricing.BASE_UNIT_CENTS)} → ${unit} per pack)`;
}

/** Build the Stripe Checkout Session params. Server-computed prices only. */
function buildCheckoutSession(items, baseUrl) {
  const q = pricing.quote(items);
  const httpsBase = baseUrl.startsWith('https://');
  return {
    mode: 'payment',
    line_items: q.lines.map((l) => {
      const flavor = pricing.flavorById(l.flavor);
      const product = {
        name: `HELLA GOOD! Energy Gummies: ${l.name}`,
        description: describeTier(q.tier),
      };
      if (httpsBase) product.images = [baseUrl + flavor.image];
      return {
        quantity: l.qty,
        price_data: { currency: 'usd', unit_amount: l.unitCents, product_data: product },
      };
    }),
    shipping_address_collection: { allowed_countries: ['US'] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: 'Flat-rate shipping',
          fixed_amount: { amount: pricing.SHIPPING_CENTS, currency: 'usd' },
        },
      },
    ],
    phone_number_collection: { enabled: true },
    billing_address_collection: 'auto',
    success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/cancel`,
    metadata: {
      items: q.lines.map((l) => `${l.flavor}:${l.qty}`).join(','),
      total_packs: String(q.totalPacks),
      percent_off: String(q.tier.percentOff),
      unit_cents: String(q.tier.unitCents),
    },
  };
}

/** Log a paid order. Order id, items, total, shipping name + city only: no card or contact data. */
function orderSummary(session) {
  const ship =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    null;
  return {
    orderId: session.id,
    items: (session.metadata && session.metadata.items) || '',
    totalPacks: session.metadata && session.metadata.total_packs,
    total: typeof session.amount_total === 'number' ? pricing.formatCents(session.amount_total) : null,
    shipName: ship ? ship.name : null,
    shipCity: ship && ship.address ? `${ship.address.city || ''}, ${ship.address.state || ''}`.replace(/^, |, $/g, '') : null,
  };
}

const SESSION_ID_RE = /^cs_(?:test|live)_[A-Za-z0-9]{8,250}$/;
const PRODUCT_PREFIX = 'HELLA GOOD! Energy Gummies: ';

/** The /success status card. With a retrievable Checkout Session it lists the order; otherwise a generic thank-you. */
function successHtml(session) {
  const esc = site.escapeHtml;
  const lines = session && session.line_items && Array.isArray(session.line_items.data) ? session.line_items.data : null;
  if (!session || !lines || !lines.length) {
    return `      <section class="status-card" aria-labelledby="status-title">
        <p class="status-badge"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> Order received</p>
        <h1 id="status-title" class="h2">Thank <em>you!</em></h1>
        <p class="lede">Thanks for your order. Your HELLA GOOD! Energy Gummies are on the way soon.</p>
      </section>`;
  }
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  const td = session.total_details || {};
  const pct = Number(session.metadata && session.metadata.percent_off) || 0;
  const money = (c) => pricing.formatCents(Number(c) || 0);
  const rows = lines
    .map((l) => {
      const name = String(l.description || '').replace(PRODUCT_PREFIX, '');
      const unit = l.quantity ? Math.round((l.amount_total || 0) / l.quantity) : 0;
      return `          <li><span class="os-name">${esc(name)}</span><span class="os-qty">${esc(l.quantity)} &times; ${money(unit)}</span><span class="os-amt">${money(l.amount_total)}</span></li>`;
    })
    .join('\n');
  const extra = [];
  if (pct > 0) extra.push(`<div class="os-save"><dt>Mix &amp; match ${pct}% off</dt><dd>included</dd></div>`);
  extra.push(`<div><dt>Shipping</dt><dd>${money(td.amount_shipping)}</dd></div>`);
  if (td.amount_tax) extra.push(`<div><dt>Tax</dt><dd>${money(td.amount_tax)}</dd></div>`);
  return `      <section class="status-card" aria-labelledby="status-title">
        <p class="status-badge${paid ? '' : ' pending'}"><svg class="ico" aria-hidden="true"><use href="#${paid ? 'i-check' : 'i-bolt'}"/></svg> ${paid ? 'Order confirmed' : 'Payment processing'}</p>
        <h1 id="status-title" class="h2">Thank <em>you!</em></h1>
        <p class="lede">${paid ? 'Your order is confirmed. Your HELLA GOOD! Energy Gummies are on the way soon.' : 'We have your order. It ships as soon as your payment clears.'}</p>
        <div class="order-summary">
          <h2 class="status-h3">Order summary <span class="os-ref">Ref &hellip;${esc(String(session.id).slice(-8))}</span></h2>
          <ul class="os-lines">
${rows}
          </ul>
          <dl class="os-totals">
            <div><dt>Subtotal</dt><dd>${money(session.amount_subtotal)}</dd></div>
            ${extra.join('\n            ')}
            <div class="os-grand"><dt>Total</dt><dd>${money(session.amount_total)}</dd></div>
          </dl>
        </div>
      </section>`;
}

function createApp(opts = {}) {
  const stripe = 'stripe' in opts ? opts.stripe : makeStripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = 'webhookSecret' in opts ? opts.webhookSecret : process.env.STRIPE_WEBHOOK_SECRET;
  const publicUrl = 'publicUrl' in opts ? opts.publicUrl : process.env.PUBLIC_URL;
  const log = opts.logger || console;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway sits behind one proxy hop

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://js.stripe.com'],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'https://*.stripe.com'],
          'connect-src': ["'self'", 'https://api.stripe.com'],
          'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://checkout.stripe.com'],
          'form-action': ["'self'", 'https://checkout.stripe.com'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use(compression());

  app.get('/health', (req, res) => res.json({ ok: true, checkout: Boolean(stripe) }));

  // Stripe webhook needs the raw body for signature checks, so it is mounted before express.json.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).json({ ok: false, error: 'Webhook not configured.' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
    } catch (err) {
      log.warn('[webhook] signature check failed:', err.message);
      return res.status(400).json({ ok: false, error: 'Invalid signature.' });
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') log.info('[order paid]', JSON.stringify(orderSummary(session)));
    }
    res.json({ received: true });
  });

  app.use('/api', express.json({ limit: '10kb' }));

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ checkoutEnabled: Boolean(stripe), checkoutMessage: stripe ? null : CHECKOUT_SOON });
  });

  const checkoutLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many checkout attempts. Please wait a few minutes and try again.' },
  });

  app.post('/api/checkout', checkoutLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const v = pricing.validateItems(body.items);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

    const q = pricing.quote(v.items);
    if (!stripe) {
      return res.status(503).json({ ok: false, code: 'checkout_unavailable', message: CHECKOUT_SOON, quote: q });
    }
    try {
      const session = await stripe.checkout.sessions.create(buildCheckoutSession(v.items, baseUrlFor(req, publicUrl)));
      res.json({ ok: true, url: session.url, quote: q });
    } catch (err) {
      log.error('[checkout] Stripe error:', err && err.message);
      res.status(502).json({ ok: false, error: 'We could not start checkout right now. Please try again in a moment.' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

  /* ---------- pages ---------- */
  const renderer = site.createRenderer();
  const originFor = (req) => baseUrlFor(req, publicUrl);
  const sendPage = (req, res, key, extra = {}, status = 200) => {
    res.status(status).set('Cache-Control', 'no-cache').type('html');
    res.send(renderer.render(key, { origin: originFor(req), checkoutEnabled: Boolean(stripe), ...extra }));
  };

  app.get('/robots.txt', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(site.robotsTxt(originFor(req)));
  });
  app.get('/sitemap.xml', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(site.sitemapXml(originFor(req), renderer.sitemapRoutes()));
  });

  app.get('/success', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const id = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    let session = null;
    if (stripe && SESSION_ID_RE.test(id)) {
      try {
        session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
      } catch (err) {
        log.warn('[success] could not load session:', err && err.message);
      }
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderer.render('/success', { origin: originFor(req), checkoutEnabled: Boolean(stripe), main: successHtml(session) }));
  });

  // Checkout Sessions created before /success and /cancel existed still return to /?checkout=...
  app.get('/', (req, res, next) => {
    const sid = typeof req.query.session_id === 'string' && SESSION_ID_RE.test(req.query.session_id) ? req.query.session_id : '';
    if (req.query.checkout === 'success') return res.redirect(302, '/success' + (sid ? `?session_id=${sid}` : ''));
    if (req.query.checkout === 'cancelled') return res.redirect(302, '/cancel');
    next();
  });

  for (const route of Object.keys(site.PAGES)) {
    if (route !== '/success') app.get(route, (req, res) => sendPage(req, res, route));
  }

  // Templates are never served raw: /privacy.html -> /privacy, /index.html -> /, anything else .html -> 404.
  app.use((req, res, next) => {
    if (!/\.html?$/i.test(req.path)) return next();
    const clean = req.path.replace(/\.html?$/i, '').replace(/\/index$/, '/') || '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    if (clean in site.PAGES) return res.redirect(301, clean + qs);
    return sendPage(req, res, '404', {}, 404);
  });

  const YEAR = 365 * 24 * 60 * 60;
  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders(res, filePath) {
        // Pages reference assets as ?v=<content hash>, so those URLs can be cached for a year.
        const versioned = res.req && res.req.query && typeof res.req.query.v === 'string';
        if (versioned) res.setHeader('Cache-Control', `public, max-age=${YEAR}, immutable`);
        else if (/\.(webp|png|jpg|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    })
  );

  app.use((req, res) => sendPage(req, res, '404', {}, 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large.' });
    log.error('[error]', err && err.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    const mode = process.env.STRIPE_SECRET_KEY ? 'Stripe checkout ON' : 'Stripe key not set: checkout shows "opens soon"';
    console.log(`HELLA GOOD! storefront on :${port} (${mode})`);
  });
}

module.exports = { createApp, buildCheckoutSession, orderSummary, successHtml, CHECKOUT_SOON };
