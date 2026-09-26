'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const pricing = require('./public/js/pricing.js');
const site = require('./lib/site.js');
const pkg = require('./package.json');

const CHECKOUT_SOON = 'Checkout opens soon! Online ordering for HELLA GOOD! Energy Gummies is almost live. Your cart is saved.';

/**
 * The secret key as pasted into Railway, or '' when it's unset, empty, or clearly not a Stripe secret key
 * (a publishable pk_ key, a placeholder, stray quotes). Only sk_/rk_ keys turn checkout on, so a key pasted
 * into the wrong box leaves the store on "Checkout opens soon" instead of failing at the customer's checkout.
 */
function cleanSecretKey(raw) {
  const k = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  return /^(?:sk|rk)_(?:live|test)_\w+$/.test(k) ? k : '';
}
/** The webhook signing secret, or '' unless it looks like one (whsec_…). */
function cleanWebhookSecret(raw) {
  const k = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  return /^whsec_\w+$/.test(k) ? k : '';
}
/** One line for the boot log about the key, never the key itself. */
function keyStatus(raw) {
  if (!String(raw || '').trim()) return 'Stripe key not set: checkout shows "opens soon"';
  const k = cleanSecretKey(raw);
  if (!k) return 'STRIPE_SECRET_KEY is set but is not a Stripe secret key (it must start with sk_live_ or sk_test_): checkout stays off';
  return `Stripe checkout ON (${k.includes('_live_') ? 'live' : 'TEST'} mode)`;
}

function makeStripe(secretKey) {
  secretKey = cleanSecretKey(secretKey);
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

/**
 * A request path that is safe to log: no query string (it can carry ids), no control characters, and
 * anything shaped like an email address or a long number (phone, card, order) is redacted.
 */
function logPath(url) {
  let p = String(url || '').split('?')[0].split('#')[0];
  try {
    p = decodeURIComponent(p);
  } catch (e) {
    /* keep the raw path */
  }
  return p
    .slice(0, 200)
    .replace(/[^\x21-\x7e]/g, '?')
    .replace(/[^/@]*@[^/@]*/g, '[redacted]')
    .replace(/\d{6,}/g, '[redacted]');
}

const STATIC_RE = /^\/(?:css|js|images|fonts)\/|^\/(?:favicon\.svg|favicon\.ico|apple-touch-icon\.png)$/;

/**
 * One line per request: method, path, status and duration. Never the IP, user agent, referrer, cookies,
 * query string or body. Health checks and successful static asset hits are skipped to keep the log readable.
 */
function requestLogger(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const p = logPath(req.originalUrl);
      if (p === '/health') return;
      if (res.statusCode < 400 && STATIC_RE.test(p)) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log.info(`[req] ${req.method} ${p} ${res.statusCode} ${Math.round(ms)}ms`);
    });
    next();
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
  const webhookSecret = 'webhookSecret' in opts ? opts.webhookSecret : (cleanWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET) || undefined);
  const publicUrl = 'publicUrl' in opts ? opts.publicUrl : process.env.PUBLIC_URL;
  const log = opts.logger || console;
  const commit = 'commit' in opts ? opts.commit : process.env.RAILWAY_GIT_COMMIT_SHA;
  const version = commit ? String(commit).slice(0, 7) : pkg.version;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway sits behind one proxy hop
  app.locals.draining = false; // set on SIGTERM so /health tells the proxy to stop sending traffic
  app.use(requestLogger(log));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://js.stripe.com'],
          'style-src': ["'self'"],
          'font-src': ["'self'"],
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

  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = { ok: !app.locals.draining, checkout: Boolean(stripe), version, commit: commit || null };
    res.status(app.locals.draining ? 503 : 200).json(body);
  });

  // Nothing under /api is ever cached: prices, config and checkout sessions are per request.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

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

  // RFC 9116. Expires is always about six months out; the contact is a placeholder until Nav sets one.
  app.get('/.well-known/security.txt', (req, res) => {
    const expires = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000);
    expires.setUTCHours(0, 0, 0, 0);
    res.set('Cache-Control', 'public, max-age=86400').type('text/plain').send(site.securityTxt(originFor(req), expires));
  });
  app.get('/security.txt', (req, res) => res.redirect(301, '/.well-known/security.txt'));

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
  const assetCache = (req) =>
    typeof req.query.v === 'string' ? `public, max-age=${YEAR}, immutable` : 'public, max-age=3600';

  // The stylesheet is minified once at startup and served from memory.
  const css = site.minifyCss(fs.readFileSync(path.join(__dirname, 'public', 'css', 'styles.css'), 'utf8'));
  app.get('/css/styles.css', (req, res) => {
    res.set('Cache-Control', assetCache(req)).type('text/css').send(css);
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders(res, filePath) {
        // Pages reference assets as ?v=<content hash>, and font file names carry their upstream version,
        // so both can be cached for a year.
        const versioned = res.req && res.req.query && typeof res.req.query.v === 'string';
        if (versioned || /\.woff2$/.test(filePath)) res.setHeader('Cache-Control', `public, max-age=${YEAR}, immutable`);
        else if (/\.(avif|webp|png|jpg|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    })
  );

  // Test hook: extra routes that run before the 404 handler (used to exercise the error page).
  if (typeof opts.extraRoutes === 'function') opts.extraRoutes(app);

  app.use((req, res) => sendPage(req, res, '404', {}, 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err); // Express closes the connection
    res.set('Cache-Control', 'no-store');
    const wantsJson = req.originalUrl.startsWith('/api') || !req.accepts('html');
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large.' });
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) {
      // Client errors (a malformed URL, say): short answer, nothing logged beyond the request line.
      if (wantsJson) return res.status(status).json({ ok: false, error: 'Bad request.' });
      if (status === 404) return sendPage(req, res, '404', {}, 404);
      return res.status(status).type('text/plain').send('Bad request.');
    }
    log.error('[error]', req.method, logPath(req.originalUrl), err && err.message);
    if (wantsJson) return res.status(500).json({ ok: false, error: 'Something went wrong.' });
    try {
      res.status(500).type('html').send(renderer.render('500', { origin: originFor(req), checkoutEnabled: Boolean(stripe) }));
    } catch (e) {
      res.status(500).type('text/plain').send('Something went wrong. Please try again in a moment.');
    }
  });

  return app;
}

/**
 * Listen on PORT and shut down cleanly on SIGTERM / SIGINT (Railway sends SIGTERM on every redeploy):
 * /health starts answering 503, the listener stops taking new connections, in-flight requests finish,
 * idle keep-alive sockets are closed, and the process exits 0. After `graceMs` it exits 1 regardless.
 */
function start({ port = process.env.PORT ? Number(process.env.PORT) : 3000, graceMs = 10000, log = console } = {}) {
  const app = createApp();
  const server = app.listen(port, (err) => {
    if (err) {
      log.error(`Could not listen on :${port}: ${err.message}`);
      process.exit(1);
    }
    const mode = keyStatus(process.env.STRIPE_SECRET_KEY);
    log.log(`HELLA GOOD! storefront on :${server.address().port} (${mode})`);
  });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    app.locals.draining = true;
    log.log(`[shutdown] ${signal}: finishing in-flight requests`);
    server.close((err) => {
      log.log('[shutdown] done');
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      log.error(`[shutdown] still busy after ${graceMs}ms, exiting`);
      server.closeAllConnections();
      process.exit(1);
    }, graceMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, buildCheckoutSession, orderSummary, successHtml, logPath, CHECKOUT_SOON, cleanSecretKey, cleanWebhookSecret, keyStatus, makeStripe };
