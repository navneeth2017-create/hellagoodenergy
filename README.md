# Marshawn Lynch HELLA GOOD! Energy Gummies: storefront

Direct-to-consumer store for Hella Good Energy. Node + Express serves a static, mobile-first page and
creates Stripe Checkout Sessions. The server prices every order itself; the browser's numbers are for display only.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # pricing, validation, checkout payload (stubbed Stripe), webhook, headers
```

Without `STRIPE_SECRET_KEY` the whole site works, and Checkout shows a friendly
"Checkout opens soon" notice instead of redirecting to Stripe.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | For live checkout | Hella Good Energy's Stripe secret key (`sk_live_...`, or `sk_test_...` while testing). If unset, checkout returns "Checkout opens soon". |
| `STRIPE_WEBHOOK_SECRET` | Optional | Signing secret (`whsec_...`) for `/api/stripe/webhook`. When set, paid orders are logged (order id, items, total, ship-to name and city; no card or contact data). |
| `PORT` | Railway sets it | Port to listen on. Defaults to 3000. |
| `PUBLIC_URL` | Recommended in production | Canonical site URL for Stripe's success/cancel links and product images, e.g. `https://www.yourdomain.com`. Falls back to Railway's domain, then the request host. |
| `NODE_ENV` | Optional | Set to `production` to add the `upgrade-insecure-requests` CSP directive. |

Never commit keys. Put them in Railway → service → **Variables**.

## Pricing rules (Nav)

- $5.99 per pack. Flavors mix and match toward the tier.
- 5+ packs: 10% off the whole order ($5.39 per pack). 15+ packs: 20% off ($4.79 per pack).
- Flat $7.99 shipping per order, US addresses only.
- 1–100 packs per flavor per order.

The rules live in `public/js/pricing.js`, which the server and browser both load. Stripe line items carry the
discounted unit price, and the line item description names the discount.

## Stripe setup

1. Stripe Dashboard → Developers → API keys: copy the secret key into `STRIPE_SECRET_KEY` on Railway.
2. Developers → Webhooks → Add endpoint: `https://www.yourdomain.com/api/stripe/webhook`,
   events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Settings → Emails: turn on "Successful payments" if customers should get Stripe receipts.
4. Paid orders show in Railway logs as `[order paid] {...}` and, with full detail, in the Stripe Dashboard.

## Deploy on Railway

`railway.json` starts `node server.js`, restarts on failure (5 retries) and health-checks `/health`.
Connect the GitHub repo to a Railway service, add the variables above, and deploy.
`package.json` allows Node 20 or newer (Node 20 is past end of life, so a current LTS is the better choice).

## Point a GoDaddy domain at Railway

1. Railway → service → **Settings → Networking → Custom Domain** → add `www.yourdomain.com`.
   Railway shows a **CNAME** target (something like `xxxx.up.railway.app`) and may ask for a **TXT** verification record.
2. GoDaddy → **My Products → Domain → DNS → Manage DNS**:
   - Edit or add a record: Type `CNAME`, Name `www`, Value = the Railway target, TTL 1 hour.
     Remove any existing `www` CNAME or A record first.
   - If Railway gave a TXT record, add it exactly (Type `TXT`, Name and Value as shown).
3. The bare domain (`yourdomain.com`): GoDaddy can't CNAME the apex. Use GoDaddy **Forwarding**
   (Domain → Forwarding → add `https://www.yourdomain.com`, 301 permanent), or move DNS to a provider that supports
   CNAME flattening (for example Cloudflare) and add the apex there too.
4. Wait for Railway to show the domain as verified with a certificate (minutes, sometimes up to a few hours).
5. Set `PUBLIC_URL=https://www.yourdomain.com` on Railway and update the Stripe webhook URL to match.

## Images

`public/images/` holds crops of the brand's own marketing pages, built by `npm run build:images`
(Python + Pillow) from `source-pages/`. Those pages are the brief only: they are git-ignored, never served, and
must be placed in `source-pages/` locally to rebuild. Crops are exported at native size, or 1.5x at most for the
pack shots, and displayed at sizes where they stay sharp.

## Visual check

```bash
SHOT_DIR=/tmp/hgg CHROMIUM_PATH=/path/to/chrome npm run screenshots
```

Captures the full page, the cart drawer with 5 mixed packs (10% tier) and the FAQ at 1440px and 390px, and checks
for horizontal scroll from 360px to 1440px. It uses a globally installed Playwright; it is not a project dependency.

## TODO for Nav

Search the page for the yellow `[TODO Nav: ...]` markers (all in `public/index.html`):

- Daily maximum gummies in the caffeine warning (product area, FAQ, footer).
- Shipping: processing time, carrier and delivery estimate.
- Returns and refunds policy.
- Support email or phone.
- Privacy Policy and Terms of Sale pages.
