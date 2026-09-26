'use strict';
/*
 * Page rendering for the storefront: the HTML pages in public/ are small templates.
 *
 *   <!--#include name -->   pulls in public/partials/name.html
 *   {{ORIGIN}}              the canonical origin (PUBLIC_URL, else Railway's domain, else the request host)
 *   {{YEAR}}                the current year
 *   {{JSONLD}}              structured data for the home page (Organization + a Product per flavor)
 *   {{MAIN}}                page-specific markup the server builds (the /success order summary)
 *
 * Local asset URLs (/css, /js, /images, icons) get a ?v=<content hash> so they can be cached for a year.
 * Fonts are left alone: styles.css and the preload tags must request the exact same URL, and the font file
 * names carry their upstream version instead.
 * A page carrying data-draft (the policy drafts) is served noindex and left out of the sitemap until the
 * draft banner is removed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pricing = require('../public/js/pricing.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

/** Clean URL -> template file. Order is the sitemap order. */
const PAGES = {
  '/': 'index.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/success': 'success.html',
  '/cancel': 'cancel.html',
};
/** Pages that are never indexed (post-checkout pages). */
const NOINDEX = new Set(['/success', '/cancel']);

const ASSET_RE = /\/(?:(?:css|js|images)\/[\w.-]+\.(?:css|js|avif|webp|png|jpg|svg)|favicon\.svg|favicon\.ico|apple-touch-icon\.png)(?![\w.?-])/g;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Short content hash for every file a page can reference. */
function assetVersions() {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const url = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, url);
      else if (!entry.name.endsWith('.html')) out[url] = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 10);
    }
  };
  walk(PUBLIC_DIR, '');
  return out;
}

function loadTemplates() {
  const partials = {};
  for (const f of fs.readdirSync(PARTIALS_DIR)) {
    if (f.endsWith('.html')) partials[f.slice(0, -5)] = fs.readFileSync(path.join(PARTIALS_DIR, f), 'utf8').replace(/\s+$/, '');
  }
  const include = (html) =>
    html.replace(/^[ \t]*<!--#include ([\w-]+) -->/gm, (m, name) => {
      if (!(name in partials)) throw new Error(`Unknown partial: ${name}`);
      return partials[name];
    });
  const pages = {};
  for (const [route, file] of Object.entries(PAGES)) pages[route] = include(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
  for (const key of ['404', '500']) pages[key] = include(fs.readFileSync(path.join(PUBLIC_DIR, `${key}.html`), 'utf8'));
  return pages;
}

const isDraft = (html) => /\bdata-draft\b/.test(html);

/** schema.org Organization + one Product per flavor. Availability follows whether checkout is live. */
function structuredData(origin, checkoutEnabled) {
  const org = {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: 'Hella Good Energy',
    url: `${origin}/`,
    logo: `${origin}/images/logo-lockup.webp`,
  };
  const products = pricing.FLAVORS.map((f) => ({
    '@type': 'Product',
    '@id': `${origin}/#${f.id}`,
    name: `HELLA GOOD! Energy Gummies: ${f.name}`,
    sku: f.id,
    image: `${origin}${f.image}`,
    description: `Marshawn Lynch HELLA GOOD! Energy Gummies, ${f.name}. 125mg RCF caffeine per gummy, from Revibe Raw Coffee Fiber. Dietary supplement.`,
    brand: { '@type': 'Brand', name: 'HELLA GOOD!' },
    offers: {
      '@type': 'Offer',
      url: `${origin}/#flavors`,
      price: (pricing.BASE_UNIT_CENTS / 100).toFixed(2),
      priceCurrency: 'USD',
      availability: checkoutEnabled ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@id': `${origin}/#organization` },
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: (pricing.SHIPPING_CENTS / 100).toFixed(2), currency: 'USD' },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
      },
    },
  }));
  return { '@context': 'https://schema.org', '@graph': [org, ...products] };
}

/** JSON for a <script type="application/ld+json"> block, safe against "</script>". */
function jsonLdScript(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

function createRenderer() {
  const versions = assetVersions();
  const templates = loadTemplates();

  const version = (html) => html.replace(ASSET_RE, (url) => (versions[url] ? `${url}?v=${versions[url]}` : url));

  function render(key, { origin, checkoutEnabled = false, main = '' }) {
    let html = templates[key];
    if (!html) throw new Error(`Unknown page: ${key}`);
    const robots = key === '404' || key === '500' || NOINDEX.has(key) || isDraft(html);
    html = html
      .replace('{{ROBOTS}}', robots ? '<meta name="robots" content="noindex">' : '')
      .replace('{{JSONLD}}', () => jsonLdScript(structuredData(origin, checkoutEnabled)))
      .replace('{{MAIN}}', () => main)
      .replace(/\{\{ORIGIN\}\}/g, () => origin)
      .replace(/\{\{YEAR\}\}/g, String(new Date().getFullYear()));
    return version(html);
  }

  /** Indexable pages only: no drafts, no post-checkout pages. */
  function sitemapRoutes() {
    return Object.keys(PAGES).filter((r) => !NOINDEX.has(r) && !isDraft(templates[r]));
  }

  return { render, sitemapRoutes, versions };
}

function robotsTxt(origin) {
  return ['User-agent: *', 'Allow: /', 'Disallow: /api/', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
}

/**
 * /.well-known/security.txt (RFC 9116). The Contact line is a placeholder: example.com is a reserved domain,
 * so nothing is sent anywhere until Nav puts in a real address.
 */
function securityTxt(origin, expires) {
  return [
    '# Security contact for the HELLA GOOD! Energy Gummies store (RFC 9116).',
    '# [TODO Nav: replace the placeholder Contact below with a real security contact (an email or a web page) before launch]',
    'Contact: mailto:security@example.com',
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en',
    `Canonical: ${origin}/.well-known/security.txt`,
    '',
  ].join('\n');
}

/**
 * A conservative CSS minifier for our own stylesheet: drops comments and collapses whitespace, and trims it
 * around braces, semicolons and commas, and after a property name's colon. Never around "+" or "-" (calc) or
 * before a colon (a selector like ".a :hover" means something else without the space).
 */
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/([{;])([\w-]+):\s+/g, '$1$2:')
    .replace(/;}/g, '}')
    .trim();
}

function sitemapXml(origin, routes) {
  const urls = routes.map((r) => `  <url><loc>${escapeHtml(origin + r)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

module.exports = { PAGES, createRenderer, structuredData, robotsTxt, sitemapXml, securityTxt, minifyCss, escapeHtml };
