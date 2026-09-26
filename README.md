# Marshawn Lynch HELLA GOOD! Energy Gummies: storefront

Direct-to-consumer store for Hella Good Energy. Node + Express serves a static, mobile-first page and
creates Stripe Checkout Sessions. The server prices every order itself; the browser's numbers are for display only.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # pricing, validation, checkout payload (stubbed Stripe), webhook, headers, pages, SEO,
                     # caching, health, security.txt, 404/500, request log, graceful shutdown, images, fonts
```

## Pages

| URL | What it is |
| --- | --- |
| `/` | The storefront. |
| `/privacy`, `/terms` | **Drafts** of the Privacy Policy and Terms of Sale, with a yellow "Draft — Nav to review before launch" banner and placeholders for the legal name, address and contact. While a page carries `data-draft` it is served `noindex` and left out of the sitemap; delete the banner when the text is final. |
| `/success` | Stripe's success URL. With `STRIPE_SECRET_KEY` set and a valid `session_id`, it reads the Checkout Session and shows the order summary (items, discount, shipping, total; no address or contact data). Otherwise a generic thank-you. Either way it empties the saved cart. |
| `/cancel` | Stripe's cancel URL. Shows the saved cart and links back to it (`/#cart` opens the cart drawer). |
| `/robots.txt`, `/sitemap.xml` | Generated from the canonical origin. |
| `/.well-known/security.txt` | RFC 9116 security contact. The contact is a **placeholder** (`security@example.com`) until Nav sets one; `Expires` is always about six months ahead. `/security.txt` redirects here. |
| `/health` | Railway's health check: `{ ok, checkout, version, commit }`. `version` is the short commit sha from `RAILWAY_GIT_COMMIT_SHA` (the package version locally). Answers 503 while the server is shutting down. |
| anything else | Branded 404. A server error shows a branded 500 page (JSON under `/api`). |

The HTML files in `public/` are small templates rendered by `lib/site.js`: `<!--#include name -->` pulls in
`public/partials/` (shared head, icon sprite, sub-page header, footer), `{{ORIGIN}}` becomes the canonical origin,
and the home page gets JSON-LD (an Organization plus one Product per flavor: $5.99 USD, `InStock` when checkout is on,
`PreOrder` while it is off). Local asset URLs get a `?v=<content hash>` and are cached for a year; HTML is
`no-cache`. Templates are never served raw (`/privacy.html` redirects to `/privacy`).

## Caching, logging and shutdown

| What | `Cache-Control` |
| --- | --- |
| Pages (`/`, `/privacy`, `/terms`, `/cancel`, 404) | `no-cache` (revalidate every time, ETag) |
| `/success`, 500 page, `/health`, everything under `/api` | `no-store` |
| Assets referenced as `?v=<hash>`, and `/fonts/*.woff2` (versioned file names) | `public, max-age=31536000, immutable` |
| Unversioned images | one week; other unversioned files one hour |
| `robots.txt`, `sitemap.xml` / `security.txt` | one hour / one day |

Each request is logged as one line, `[req] GET /privacy 200 3ms`: method, path, status and time only. No IP, user agent,
referrer, cookies, query string or body; email-like path segments and long numbers are redacted. `/health` and successful
static asset hits are not logged.

On `SIGTERM` (Railway sends it on every redeploy) or `SIGINT`, `/health` starts answering 503, the server stops accepting
connections, lets in-flight requests finish, closes idle keep-alive sockets and exits 0 (forced exit after 10 seconds).

Without `STRIPE_SECRET_KEY` the whole site works, and Checkout shows a friendly
"Checkout opens soon" notice instead of redirecting to Stripe.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | For live checkout | Hella Good Energy's Stripe secret key (`sk_live_...`, or `sk_test_...` while testing). If unset, checkout returns "Checkout opens soon". |
| `STRIPE_WEBHOOK_SECRET` | Optional | Signing secret (`whsec_...`) for `/api/stripe/webhook`. When set, paid orders are logged (order id, items, total, ship-to name and city; no card or contact data). |
| `PORT` | Railway sets it | Port to listen on. Defaults to 3000. |
| `PUBLIC_URL` | Recommended in production | Canonical site URL for Stripe's success/cancel links, product images, the canonical tag, Open Graph URLs, JSON-LD, robots.txt and the sitemap, e.g. `https://www.yourdomain.com`. Falls back to Railway's domain, then the request host. |
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

`npm run build:share` (Python + Pillow) builds from those crops, without `source-pages/`: the 1200x630 share image
`public/images/og-image.jpg` (logo, the three packs, black and lightning), `public/apple-touch-icon.png`,
`public/favicon.ico`, the 360px `*-360.webp` variants used in `srcset`, and an AVIF twin of every WebP (about half the
bytes). Pages serve images through `<picture>`: AVIF first, WebP as the fallback.

## Fonts

Barlow Condensed (800, 800 italic, 900 italic) and Inter (400-700) are self-hosted from `public/fonts/` under the SIL
Open Font License (license texts alongside), so pages make no third-party requests. `npm run build:fonts` (Python +
fontTools with brotli) downloads the pinned upstream files and trims them to the characters the site uses; keep the
`unicode-range` in `styles.css` in sync with the script. All four are preloaded. The stylesheet is minified in memory
when the server starts.

## Motion

Blocks below the fold fade up the first time they scroll into view (anything already on screen at load is left alone,
and without JavaScript everything simply shows); cards lift slightly on hover; cart lines slide in when the drawer opens.
All of it is off for visitors who ask for reduced motion.

## Visual check

```bash
SHOT_DIR=/tmp/hgg CHROMIUM_PATH=/path/to/chrome npm run screenshots
```

Captures the full page (after scrolling through it, so every entrance animation has played), the cart drawer with 5 mixed packs (10% tier), the FAQ, the sticky mobile cart bar, `/privacy`,
`/success` (with a stubbed order summary), `/cancel`, the 404 and the share image at 1440px and 390px. It checks every
page for horizontal scroll from 360px to 1440px, and checks the cart drawer by keyboard (focus trap, Esc closes, focus
returns to the opener, updates announced). It uses a globally installed Playwright; it is not a project dependency.

## TODO for Nav

Search for the yellow `[TODO Nav: ...]` markers (in `public/*.html` and `public/partials/footer.html`):

- Daily maximum gummies in the caffeine warning (product area, FAQ, footer, Terms).
- Review the draft Privacy Policy and Terms of Sale: fill in the legal name, address, effective date, governing-law
  state and dispute resolution, have them checked, then remove the draft banners.

Filled in (Nav, 2026-09-26): orders arrive within 7 days; 30-day returns on unopened products; support and security
contact admin@hellagoodenergy.com; no minimum buyer age.
