'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const pricing = require('./public/js/pricing.js');

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
    success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled`,
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

  app.use(
    express.static(path.join(__dirname, 'public'), {
      extensions: ['html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (/\.(webp|png|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    })
  );

  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

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

module.exports = { createApp, buildCheckoutSession, orderSummary, CHECKOUT_SOON };
