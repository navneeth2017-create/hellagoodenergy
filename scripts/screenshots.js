#!/usr/bin/env node
/*
 * Visual check: full page, cart drawer (5 mixed packs = 10% tier) and FAQ at 1440 and 390 wide,
 * plus a horizontal-overflow sweep from 360 to 1440.
 *
 *   SHOT_DIR=/tmp/shots CHROMIUM_PATH=/path/to/chrome npm run screenshots
 *
 * Uses a globally installed `playwright` if it is not in node_modules (it is not a dependency,
 * so Railway never downloads browsers). Does not run `playwright install`.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { createApp } = require('../server.js');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    const root = execSync('npm root -g').toString().trim();
    return require(path.join(root, 'playwright'));
  }
}

const OUT = process.env.SHOT_DIR || path.join(require('os').tmpdir(), 'hgg-shots');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const PREFIX = process.env.SHOT_PREFIX || 'hgg';
const CART_5 = { 'blue-razz': 2, 'strawberry-lemonade': 2, 'orange-pineapple-mango': 1 };

async function settle(page) {
  // Google Fonts can be slow through a proxy: reload a couple of times before giving up.
  for (let i = 0; i < 3; i++) {
    const ok = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('900 italic 40px "Barlow Condensed"') && document.fonts.check('400 16px Inter'); });
    if (ok) break;
    await page.reload({ waitUntil: 'load' });
  }
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
    await document.fonts.ready;
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    const imgs = Array.from(document.images).filter((img) => img.offsetParent !== null);
    const loaded = Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
  });
  await page.waitForTimeout(250);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const app = createApp({ stripe: null, logger: { info() {}, warn() {}, error() {}, log() {} } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    // Pass the proxy as raw flags so loopback (the local server) is never proxied.
    args: proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [],
  });
  const problems = [];
  const files = [];

  try {
    // Overflow sweep
    for (const width of [360, 390, 414, 768, 1024, 1280, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'load' });
      await settle(page);
      if (!(await page.$('#flavors'))) throw new Error('storefront did not load (proxy?)');
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      console.log(`overflow @${width}: scrollWidth=${o.sw} clientWidth=${o.cw} ${o.sw > o.cw ? 'OVERFLOW' : 'ok'}`);
      if (o.sw > o.cw) problems.push(`horizontal overflow at ${width}px`);
      await ctx.close();
    }

    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ignoreHTTPSErrors: true, deviceScaleFactor: vp.width < 600 ? 2 : 1 });
      const page = await ctx.newPage();
      // The 503 from /api/checkout without a Stripe key is expected (friendly "opens soon" path).
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 503/.test(m.text())) problems.push(`[${vp.name}] console: ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`[${vp.name}] pageerror: ${e.message}`));

      await page.goto(base, { waitUntil: 'load' });
      await settle(page);
      const full = path.join(OUT, `${PREFIX}-${vp.name}-full.png`);
      await page.screenshot({ path: full, fullPage: true });
      files.push(full);

      const font = await page.evaluate(() => document.fonts.check('900 italic 40px "Barlow Condensed"') && document.fonts.check('400 16px Inter'));
      if (!font) problems.push(`[${vp.name}] display font did not load (fallback in use)`);

      // Cart with 5 mixed packs -> 10% tier
      await page.evaluate((c) => localStorage.setItem('hgg-cart-v1', JSON.stringify(c)), CART_5);
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      await page.click('.site-header [data-open-cart]');
      await page.waitForTimeout(600);
      const nudge = await page.textContent('[data-nudge]');
      const total = await page.textContent('[data-t-total]');
      const disc = await page.textContent('[data-t-discount]');
      console.log(`[${vp.name}] cart: nudge="${nudge.trim()}" discount=${disc} total=${total}`);
      if (!/10% off/.test(nudge) || !/Add 10 more packs to save 20%/.test(nudge)) problems.push(`[${vp.name}] unexpected nudge: ${nudge}`);
      if (total.trim() !== '$34.94') problems.push(`[${vp.name}] unexpected total ${total}`);
      const cartShot = path.join(OUT, `${PREFIX}-${vp.name}-cart.png`);
      await page.screenshot({ path: cartShot });
      files.push(cartShot);

      // Checkout without a key -> friendly notice
      await page.click('[data-checkout]');
      await page.waitForTimeout(400);
      const notice = await page.textContent('[data-checkout-notice]');
      if (!/Checkout opens soon/.test(notice)) problems.push(`[${vp.name}] missing checkout-soon notice`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);

      // FAQ
      await page.evaluate(() => {
        document.querySelectorAll('#faq details').forEach((d, i) => { d.open = i === 0 || i === 5 || i === 6; });
      });
      // Element screenshots scroll the page, so un-stick the header just for this capture.
      await page.evaluate(() => {
        document.activeElement && document.activeElement.blur();
        document.querySelector('.site-header').style.position = 'relative';
      });
      const faq = await page.$('#faq');
      await faq.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const faqShot = path.join(OUT, `${PREFIX}-${vp.name}-faq.png`);
      await faq.screenshot({ path: faqShot });
      files.push(faqShot);

      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\nScreenshots:\n' + files.map((f) => '  ' + f).join('\n'));
  if (problems.length) {
    console.log('\nProblems:\n' + problems.map((p) => '  - ' + p).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\nNo problems found.');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
