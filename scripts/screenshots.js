#!/usr/bin/env node
/*
 * Visual check at 1440 and 390 wide: the full home page, the cart drawer (5 mixed packs = 10% tier), the FAQ,
 * the sticky mobile cart bar, /privacy, /success (with a stubbed order summary), /cancel, the 404 and the
 * Open Graph image. Also a horizontal-overflow sweep of every page from 360 to 1440, and a keyboard check of
 * the cart drawer (focus trap, Esc closes, focus returns, aria-live announcement).
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
    const ok = await page.evaluate(async () => {
      await document.fonts.ready;
      return ['900 italic 40px "Barlow Condensed"', '800 italic 26px "Barlow Condensed"', '800 16px "Barlow Condensed"', '400 16px Inter'].every((f) => document.fonts.check(f));
    });
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
  const quiet = { info() {}, warn() {}, error() {}, log() {} };
  const app = createApp({ stripe: null, logger: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // A second app with a stubbed Stripe client, only to show the /success order summary.
  const demoSession = {
    payment_status: 'paid', amount_subtotal: 2695, amount_total: 3494, metadata: { percent_off: '10' },
    total_details: { amount_shipping: 799, amount_tax: 0 },
    line_items: { data: [
      { description: 'HELLA GOOD! Energy Gummies: Blue Razz', quantity: 2, amount_total: 1078 },
      { description: 'HELLA GOOD! Energy Gummies: Strawberry Lemonade', quantity: 2, amount_total: 1078 },
      { description: 'HELLA GOOD! Energy Gummies: Orange Pineapple Mango', quantity: 1, amount_total: 539 },
    ] },
  };
  const stubStripe = { checkout: { sessions: { retrieve: async (id) => ({ id, ...demoSession }) } } };
  const demo = createApp({ stripe: stubStripe, logger: quiet });
  const demoServer = await new Promise((r) => { const s = demo.listen(0, '127.0.0.1', () => r(s)); });
  const demoBase = `http://127.0.0.1:${demoServer.address().port}`;
  const PAGES = ['/', '/privacy', '/terms', '/success', '/cancel', '/nope'];

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    // Pass the proxy as raw flags so loopback (the local server) is never proxied.
    args: proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [],
  });
  const problems = [];
  const files = [];

  try {
    // Overflow sweep: every page, 360 to 1440 (home also with items in the cart, so the sticky bar shows)
    for (const width of [360, 375, 390, 414, 480, 640, 768, 900, 1024, 1280, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const row = [];
      for (const p of PAGES) {
        await page.goto(base + p, { waitUntil: 'load' });
        if (p === '/') {
          await settle(page);
          if (!(await page.$('#flavors'))) throw new Error('storefront did not load (proxy?)');
          await page.evaluate((c) => localStorage.setItem('hgg-cart-v1', JSON.stringify(c)), CART_5);
          await page.reload({ waitUntil: 'load' });
        }
        await page.evaluate(() => document.fonts.ready);
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        row.push(`${p}:${o.sw > o.cw ? 'OVERFLOW ' + o.sw : 'ok'}`);
        if (o.sw > o.cw) problems.push(`horizontal overflow on ${p} at ${width}px (${o.sw})`);
      }
      console.log(`overflow @${width}: ${row.join('  ')}`);
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

    // Keyboard: open the drawer from a card, Tab stays inside, Esc closes, focus goes back, update is announced.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'load' });
      await page.focus('[data-flavor="blue-razz"] [data-add]');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const inDrawer = [];
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        inDrawer.push(await page.evaluate(() => Boolean(document.activeElement.closest('#cart'))));
      }
      if (inDrawer.includes(false)) problems.push('keyboard: Tab escaped the cart drawer');
      // Pressing + on a line keeps focus on that + button
      await page.focus('[data-line="blue-razz"] [data-line-step="1"]');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const kept = await page.evaluate(() => document.activeElement.matches('[data-line="blue-razz"] [data-line-step="1"]'));
      if (!kept) problems.push('keyboard: focus lost after pressing + in the cart');
      const live = await page.textContent('[data-cart-live]');
      if (!/Cart: 2 packs/.test(live)) problems.push(`aria-live text unexpected: ${live}`);
      const inert = await page.evaluate(() => document.querySelector('main').inert);
      if (!inert) problems.push('background not inert while drawer open');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => ({ hidden: document.getElementById('cart').hidden, focus: document.activeElement.matches('[data-flavor="blue-razz"] [data-add]') }));
      if (!back.hidden) problems.push('keyboard: Esc did not close the drawer');
      if (!back.focus) problems.push('keyboard: focus did not return to the opener');
      console.log(`keyboard: trap=${!inDrawer.includes(false)} keep-focus=${kept} live="${live.trim()}" inert=${inert} esc=${back.hidden} return=${back.focus}`);
      await ctx.close();
    }

    // Sticky mobile cart bar
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'load' });
      await settle(page);
      await page.evaluate((c) => localStorage.setItem('hgg-cart-v1', JSON.stringify(c)), CART_5);
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      await page.evaluate(() => { const el = document.getElementById('flavors'); window.scrollTo(0, el.offsetTop - 60); });
      await page.waitForTimeout(400);
      const bar = await page.textContent('[data-cartbar]');
      if (!/Cart · \$34\.94/.test(bar)) problems.push(`sticky bar text: ${bar}`);
      const shot = path.join(OUT, `${PREFIX}-390-cartbar.png`);
      await page.screenshot({ path: shot });
      files.push(shot);
      await ctx.close();
    }

    // Sub-pages
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ignoreHTTPSErrors: true, deviceScaleFactor: vp.width < 600 ? 2 : 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`[${vp.name}] pageerror: ${e.message}`));
      // The 404 page's own status shows up as a console error; that one is expected.
      page.on('console', (m) => { if (m.type() === 'error' && !(/status of 404/.test(m.text()) && /\/nope$/.test(page.url()))) problems.push(`[${vp.name}] console: ${m.text()}`); });
      for (const [name, url] of [
        ['privacy', base + '/privacy'],
        ['success', demoBase + '/success?session_id=cs_test_a1B2c3D4e5F6g7H8Demo'],
        ['success-generic', base + '/success'],
        ['cancel', base + '/cancel'],
        ['404', base + '/nope'],
      ]) {
        if (name === 'cancel') await page.evaluate((c) => localStorage.setItem('hgg-cart-v1', JSON.stringify(c)), CART_5);
        await page.goto(url, { waitUntil: 'load' });
        await settle(page);
        const shot = path.join(OUT, `${PREFIX}-${vp.name}-${name}.png`);
        await page.screenshot({ path: shot, fullPage: name === 'privacy' || vp.width < 600 });
        files.push(shot);
      }
      await ctx.close();
    }

    // The Open Graph image itself, at its native 1200x630
    {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, bypassCSP: true });
      const page = await ctx.newPage();
      await page.goto(base + '/images/og-image.jpg', { waitUntil: 'load' });
      await page.addStyleTag({ content: 'html,body{margin:0;background:#000}img{display:block}' });
      const shot = path.join(OUT, `${PREFIX}-og.png`);
      await page.screenshot({ path: shot });
      files.push(shot);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
    demoServer.close();
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
