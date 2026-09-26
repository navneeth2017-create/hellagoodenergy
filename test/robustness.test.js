'use strict';
/* Health/version, caching per route, security.txt, the 500 page, request logging, graceful shutdown, assets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createApp, logPath } = require('../server.js');
const site = require('../lib/site.js');
const pkg = require('../package.json');

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
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const get = (base, p, init) => fetch(base + p, { redirect: 'manual', ...init });

test('/health reports the deploy version from RAILWAY_GIT_COMMIT_SHA and is never cached', async () => {
  const sha = '3f9c2a7e1b4d5c6f7a8b9c0d1e2f3a4b5c6d7e8f';
  await withServer(createApp({ stripe: null, logger: quiet, commit: sha }), async (base) => {
    const r = await get(base, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { ok: true, checkout: false, version: '3f9c2a7', commit: sha });
  });
  // Without a commit (local runs) the package version stands in.
  await withServer(createApp({ stripe: null, logger: quiet, commit: undefined }), async (base) => {
    const j = await (await get(base, '/health')).json();
    assert.equal(j.version, pkg.version);
    assert.equal(j.commit, null);
  });
  // The env var is read when no override is given.
  const prev = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = sha;
  try {
    await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
      assert.equal((await (await get(base, '/health')).json()).version, '3f9c2a7');
    });
  } finally {
    if (prev === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = prev;
  }
});

test('/health answers 503 while the server drains for shutdown', async () => {
  const app = createApp({ stripe: null, logger: quiet });
  await withServer(app, async (base) => {
    app.locals.draining = true;
    const r = await get(base, '/health');
    assert.equal(r.status, 503);
    assert.equal((await r.json()).ok, false);
  });
});

test('every route has a deliberate Cache-Control', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const versionedCss = html.match(/\/css\/styles\.css\?v=[0-9a-f]{10}/)[0];
    const versionedAvif = html.match(/\/images\/hero-marshawn\.avif\?v=[0-9a-f]{10}/)[0];
    const YEAR = 'public, max-age=31536000, immutable';
    const cases = [
      ['GET', '/', 200, 'no-cache'],
      ['GET', '/privacy', 200, 'no-cache'],
      ['GET', '/terms', 200, 'no-cache'],
      ['GET', '/cancel', 200, 'no-cache'],
      ['GET', '/success', 200, 'no-store'],
      ['GET', '/nope', 404, 'no-cache'],
      ['GET', '/health', 200, 'no-store'],
      ['GET', '/api/config', 200, 'no-store'],
      ['POST', '/api/checkout', 400, 'no-store'],
      ['GET', '/api/nope', 404, 'no-store'],
      ['GET', '/robots.txt', 200, 'public, max-age=3600'],
      ['GET', '/sitemap.xml', 200, 'public, max-age=3600'],
      ['GET', '/.well-known/security.txt', 200, 'public, max-age=86400'],
      ['GET', versionedCss, 200, YEAR],
      ['GET', '/css/styles.css', 200, 'public, max-age=3600'],
      ['GET', versionedAvif, 200, YEAR],
      ['GET', '/images/pack-blue-razz.avif', 200, 'public, max-age=604800'],
      ['GET', '/images/pack-blue-razz.webp', 200, 'public, max-age=604800'],
      ['GET', '/fonts/inter-v20-latin.woff2', 200, YEAR],
      ['GET', '/fonts/OFL-Inter.txt', 200, 'public, max-age=3600'],
    ];
    for (const [method, p, status, cc] of cases) {
      const init = method === 'POST' ? { method, headers: { 'Content-Type': 'application/json' }, body: '{}' } : {};
      const r = await get(base, p, init);
      assert.equal(r.status, status, `${method} ${p} status`);
      assert.equal(r.headers.get('cache-control'), cc, `${method} ${p} cache-control`);
    }
  });
});

test('security.txt: RFC 9116 fields, a placeholder contact flagged for Nav, and an Expires under a year out', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/.well-known/security.txt');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    const body = await r.text();
    assert.match(body, /^Contact: mailto:security@example\.com$/m);
    assert.match(body, /\[TODO Nav: replace the placeholder Contact/);
    assert.match(body, /^Preferred-Languages: en$/m);
    assert.ok(body.includes(`Canonical: ${ORIGIN}/.well-known/security.txt`));
    const expires = new Date(body.match(/^Expires: (.+)$/m)[1]);
    const days = (expires - Date.now()) / 86400000;
    assert.ok(days > 90 && days < 365, `Expires ${days} days out`);

    const legacy = await get(base, '/security.txt');
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.get('location'), '/.well-known/security.txt');
  });
});

test('500: branded HTML page for browsers, JSON otherwise, never cached, details stay in the log', async () => {
  const errors = [];
  const logger = { ...quiet, error: (...a) => errors.push(a.join(' ')) };
  const extraRoutes = (app) =>
    app.get('/boom', () => {
      throw new Error('kaboom internal detail');
    });
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger, extraRoutes }), async (base) => {
    const r = await get(base, '/boom?session_id=cs_test_secret123', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-type'), /^text\/html/);
    const html = await r.text();
    assert.match(html, /We hit a <em>snag<\/em>/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<footer class="site-footer">/);
    assert.doesNotMatch(html, /kaboom|<!--#include|\{\{[A-Z]+\}\}/);

    const j = await get(base, '/boom', { headers: { accept: 'application/json' } });
    assert.equal(j.status, 500);
    assert.deepEqual(await j.json(), { ok: false, error: 'Something went wrong.' });

    assert.equal(errors.length, 2);
    assert.match(errors[0], /\[error\] GET \/boom kaboom internal detail/);
    assert.doesNotMatch(errors.join('\n'), /cs_test_secret123/, 'no query strings in the error log');
  });
});

test('client errors such as a malformed URL are a 400, not a 500', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await get(base, '/images/%E0%A4%A.webp');
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });
});

test('request log: method, path, status and time only; no query, IP, user agent, referrer or emails', async () => {
  const lines = [];
  const logger = { ...quiet, info: (...a) => lines.push(a.join(' ')) };
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger }), async (base) => {
    const headers = { 'user-agent': 'SecretBrowser/1.0', referer: 'https://ref.example/private', 'x-forwarded-for': '203.0.113.9', cookie: 'sid=abc' };
    await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8', { headers });
    await get(base, '/orders/jane.doe%40example.com/5551234567', { headers });
    await get(base, '/health', { headers });
    await get(base, '/images/pack-blue-razz.webp', { headers });
    await get(base, '/images/missing.webp', { headers });
    await fetch(base + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ flavor: 'blue-razz', qty: 1 }], email: 'buyer@example.com' }) });
  });
  const reqs = lines.filter((l) => l.startsWith('[req]')).map((l) => l.replace(/ \d+ms$/, ' Nms'));
  assert.deepEqual(reqs, [
    '[req] GET /success 200 Nms',
    '[req] GET /orders/[redacted]/[redacted] 404 Nms',
    '[req] GET /images/missing.webp 404 Nms',
    '[req] POST /api/checkout 503 Nms',
  ]);
  const all = lines.join('\n');
  for (const secret of ['cs_test_a1B2', 'SecretBrowser', 'ref.example', '203.0.113.9', '127.0.0.1', 'sid=abc', 'jane.doe', '5551234567', 'buyer@example.com']) {
    assert.ok(!all.includes(secret), `log leaks ${secret}`);
  }
});

test('logPath strips queries, control characters, emails and long numbers', () => {
  assert.equal(logPath('/success?session_id=cs_test_x'), '/success');
  assert.equal(logPath('/a%0Ab'), '/a?b');
  assert.equal(logPath('/u/someone@example.org/x'), '/u/[redacted]/x');
  assert.equal(logPath('/track/4111111111111111'), '/track/[redacted]');
  assert.equal(logPath('/%E0%A4%A'), '/%E0%A4%A');
  assert.equal(logPath('/' + 'a'.repeat(500)).length, 200);
});

test('SIGTERM: drains, closes keep-alive sockets and exits 0', { timeout: 20000 }, async () => {
  const env = { ...process.env, PORT: '0', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    child.stdout.on('data', () => {
      const m = out.match(/storefront on :(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });
  // A keep-alive connection that stays open must not hold the process up.
  const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { connection: 'keep-alive' } });
  assert.equal(r.status, 200);
  await r.json();
  const t0 = Date.now();
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0, out);
  assert.ok(Date.now() - t0 < 5000, 'exits promptly');
  assert.match(out, /\[shutdown\] SIGTERM: finishing in-flight requests/);
  assert.match(out, /\[shutdown\] done/);
});

test('images: every <picture> offers AVIF first and every referenced file is served with the right type', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const pictures = html.match(/<picture>[\s\S]*?<\/picture>/g);
    assert.equal(pictures.length, 8);
    for (const p of pictures) assert.match(p, /^<picture><source type="image\/avif" srcset="[^"]+\.avif\?v=[0-9a-f]{10}[^"]*"(?: sizes="[^"]+")?><img /);
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\/images\/[^"]+)"|(?:srcset|imagesrcset)="([^"]+)"/g)) {
      if (m[1]) urls.add(m[1]);
      if (m[2]) for (const part of m[2].split(',')) urls.add(part.trim().split(/\s+/)[0]);
    }
    const images = [...urls].filter((u) => u.startsWith('/images/'));
    assert.ok(images.length >= 20, `found ${images.length}`);
    for (const u of images) {
      const r = await get(base, u);
      assert.equal(r.status, 200, u);
      const ext = u.split('?')[0].split('.').pop();
      const type = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }[ext];
      assert.equal(r.headers.get('content-type'), type, u);
    }
  });
});

test('fonts: self-hosted, preloaded with the exact URLs the stylesheet uses, license alongside', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const css = await (await get(base, '/css/styles.css')).text();
    const cssFonts = [...css.matchAll(/url\((\/fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    assert.equal(cssFonts.length, 4);
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
    assert.ok(preloads.length >= 2);
    for (const p of preloads) assert.ok(cssFonts.includes(p), `preload ${p} matches a @font-face url`);
    for (const f of cssFonts) {
      const r = await get(base, f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get('content-type'), 'font/woff2');
    }
    for (const lic of ['/fonts/OFL-BarlowCondensed.txt', '/fonts/OFL-Inter.txt']) {
      assert.match(await (await get(base, lic)).text(), /SIL Open Font License/);
    }
  });
});

test('stylesheet is served minified, and the minifier keeps the spaces that matter', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await get(base, '/css/styles.css');
    assert.match(r.headers.get('content-type'), /^text\/css/);
    const css = await r.text();
    assert.ok(css.length < src.length * 0.9, `${css.length} vs ${src.length}`);
    assert.doesNotMatch(css, /\/\*/);
    assert.match(css, /\.h2\{font:italic 900 clamp\(44px,11vw,88px\)\/0\.9 var\(--display\)/);
  });
  const m = site.minifyCss('/* c */\n.a :hover { width: calc(100% - 14px); content: "a b"; }\n.b,\n.c { color: red; }\n');
  assert.equal(m, '.a :hover{width:calc(100% - 14px);content:"a b"}.b,.c{color:red}');
});

test('entrance and hover motion only run when the visitor has not asked for reduced motion', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const blocks = css.split(/(?=@media)/);
  const revealBlocks = blocks.filter((b) => /\.reveal\s*\{/.test(b));
  assert.ok(revealBlocks.length >= 1);
  for (const b of revealBlocks) assert.match(b, /^@media screen and \(prefers-reduced-motion: no-preference\)/);
  const hover = blocks.filter((b) => /\.flavor-card:hover\s*\{\s*transform/.test(b));
  for (const b of hover) assert.match(b, /prefers-reduced-motion: no-preference/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: no-preference\)'\)\.matches/);
});

test('brand links: the accessible name starts with the visible text', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    for (const p of ['/', '/privacy', '/nope']) {
      const html = await (await get(base, p)).text();
      const links = html.match(/<a class="brand[^"]*"[^>]*>[\s\S]*?<\/a>/g);
      assert.ok(links.length >= 2, p);
      for (const a of links) {
        const label = a.match(/aria-label="([^"]+)"/)[1];
        const text = a.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        assert.equal(text, 'HELLA GOOD!');
        assert.ok(label.startsWith(text), `${label} / ${text}`);
      }
    }
  });
});
