/* HELLA GOOD! storefront: cart drawer, live tier pricing, checkout. Prices shown here are for display; the server re-prices every order. */
(function () {
  'use strict';

  const P = window.HGGPricing;
  const STORE_KEY = 'hgg-cart-v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const money = P.formatCents;
  const clampQty = (n) => Math.max(P.MIN_QTY, Math.min(P.MAX_QTY_PER_FLAVOR, Math.round(Number(n) || 0)));

  let config = { checkoutEnabled: null, checkoutMessage: null };

  /* ---------- storage (per-browser convenience, never trusted by the server) ---------- */
  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      const cart = {};
      for (const f of P.FLAVORS) {
        const q = Number(raw[f.id]);
        if (Number.isInteger(q) && q > 0) cart[f.id] = Math.min(q, P.MAX_QTY_PER_FLAVOR);
      }
      return cart;
    } catch (e) {
      return {};
    }
  }
  function saveCart() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cart));
    } catch (e) {
      /* private mode: cart still works for this visit */
    }
  }
  let cart = loadCart();

  const items = () => P.FLAVORS.filter((f) => cart[f.id] > 0).map((f) => ({ flavor: f.id, qty: cart[f.id] }));

  function setQty(id, qty) {
    if (qty <= 0) delete cart[id];
    else cart[id] = clampQty(qty);
    saveCart();
    render();
  }
  function addQty(id, qty) {
    setQty(id, Math.min(P.MAX_QTY_PER_FLAVOR, (cart[id] || 0) + qty));
  }

  /* ---------- screen reader announcements ---------- */
  const live = $('[data-cart-live]');
  let liveTimer = null;
  function cartSummary() {
    const q = P.quote(items());
    if (!q.totalPacks) return 'Your cart is empty.';
    const packs = `${q.totalPacks} ${q.totalPacks === 1 ? 'pack' : 'packs'}`;
    const off = q.tier.percentOff ? `, ${q.tier.percentOff}% off` : '';
    return `Cart: ${packs}${off}, total ${money(q.totalCents)} with shipping.`;
  }
  function announce(msg) {
    // Clear first so the same message twice in a row is still read out.
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = `${msg} ${cartSummary()}`; }, 60);
  }
  const flavorName = (id) => (P.flavorById(id) || { name: '' }).name;

  /* ---------- rendering ---------- */
  const els = {
    count: $$('[data-cart-count]'),
    bar: $('[data-cartbar]'),
    barCount: $('[data-cartbar-count]'),
    barTotal: $('[data-cartbar-total]'),
    barNote: $('[data-cartbar-note]'),
    headingCount: $('[data-cart-heading-count]'),
    lines: $('[data-cart-lines]'),
    empty: $('[data-cart-empty]'),
    quickAdd: $('[data-quick-add]'),
    nudge: $('[data-nudge]'),
    fill: $('[data-tier-fill]'),
    marks: $$('[data-mark]'),
    list: $('[data-t-list]'),
    discRow: $('[data-t-discount-row]'),
    discLabel: $('[data-t-discount-label]'),
    disc: $('[data-t-discount]'),
    ship: $('[data-t-ship]'),
    total: $('[data-t-total]'),
    checkout: $('[data-checkout]'),
    notice: $('[data-checkout-notice]'),
  };

  function nudgeHtml(total) {
    const n = P.nextTier(total);
    if (total <= 0) return 'Mix any <em>5 packs</em> to save 10%';
    if (!n) return `<em>20% off</em> unlocked. Best price per pack`;
    const packs = n.packsNeeded === 1 ? '1 more pack' : `${n.packsNeeded} more packs`;
    const current = P.tierFor(total).percentOff;
    const lead = current ? `<em>${current}% off</em> unlocked. ` : '';
    return `${lead}Add ${packs} to save <em>${n.percentOff}%</em>`;
  }

  function lineHtml(line, flavor, tier) {
    const was = tier.percentOff ? `<s>${money(P.BASE_UNIT_CENTS)}</s>` : '';
    return `
      <li class="cart-line" data-color="${flavor.color}" data-line="${flavor.id}">
        <img src="${flavor.image}" alt="" width="64" height="80" loading="lazy">
        <div>
          <h3>${flavor.name}</h3>
          <p class="unit">${was}${money(line.unitCents)} / pack</p>
          <div class="stepper sm">
            <button type="button" data-line-step="-1" aria-label="Decrease ${flavor.name}"><svg class="ico" aria-hidden="true"><use href="#i-minus"/></svg></button>
            <input type="number" inputmode="numeric" min="1" max="${P.MAX_QTY_PER_FLAVOR}" value="${line.qty}" aria-label="${flavor.name} quantity" data-line-qty>
            <button type="button" data-line-step="1" aria-label="Increase ${flavor.name}"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg></button>
          </div>
        </div>
        <div class="right">
          <span class="line-total">${money(line.lineCents)}</span>
          <button type="button" class="link-btn" data-remove>Remove</button>
        </div>
      </li>`;
  }

  function render() {
    const its = items();
    const q = P.quote(its);
    const total = q.totalPacks;

    els.count.forEach((el) => {
      el.textContent = String(total);
      el.classList.toggle('has', total > 0);
      el.setAttribute('aria-label', `${total} ${total === 1 ? 'pack' : 'packs'} in cart`);
    });
    els.headingCount.textContent = total ? `(${total} ${total === 1 ? 'pack' : 'packs'})` : '';

    // Re-rendering the lines replaces their buttons, so remember which control had focus and put it back
    // (or on the nearest line, or the first quick add when the cart empties). Keyboard users never lose their place.
    const active = document.activeElement;
    let restore = null;
    if (active && els.lines.contains(active)) {
      const lineEl = active.closest('[data-line]');
      const sel = active.hasAttribute('data-line-step')
        ? `[data-line-step="${active.dataset.lineStep}"]`
        : active.hasAttribute('data-remove') ? '[data-remove]' : '[data-line-qty]';
      restore = { id: lineEl.dataset.line, sel, index: $$('[data-line]', els.lines).indexOf(lineEl) };
    }
    els.lines.innerHTML = q.lines.map((l) => lineHtml(l, P.flavorById(l.flavor), q.tier)).join('');
    els.empty.hidden = total > 0;
    if (restore) {
      const lineEl = els.lines.querySelector(`[data-line="${restore.id}"]`);
      let target = lineEl && lineEl.querySelector(restore.sel);
      if (!target) {
        const rows = $$('[data-line]', els.lines);
        const near = rows[Math.min(restore.index, rows.length - 1)];
        target = near ? near.querySelector('[data-line-qty]') : $('[data-quick]', els.quickAdd);
      }
      if (target) {
        target.focus({ preventScroll: true });
        if (target.matches('[data-line-qty]')) {
          const len = target.value.length;
          try { target.setSelectionRange(len, len); } catch (e) { /* number inputs */ }
        }
      }
    }

    els.nudge.innerHTML = nudgeHtml(total);
    els.fill.style.width = Math.min(100, (total / 15) * 100) + '%';
    els.marks.forEach((m) => m.classList.toggle('hit', total >= Number(m.dataset.mark)));

    els.list.textContent = money(q.listCents);
    els.discRow.hidden = q.savingsCents <= 0;
    els.discLabel.textContent = `Mix & match ${q.tier.percentOff}% off`;
    els.disc.textContent = '−' + money(q.savingsCents);
    els.ship.textContent = total ? money(q.shippingCents) : '—';
    els.total.textContent = money(q.totalCents);
    els.checkout.disabled = total === 0;
    els.checkout.textContent = total ? `Checkout · ${money(q.totalCents)}` : 'Checkout';

    // Sticky mobile cart bar (CSS keeps it to small screens).
    els.bar.hidden = total === 0;
    document.documentElement.classList.toggle('has-cartbar', total > 0);
    els.barCount.textContent = String(total);
    els.barTotal.textContent = money(q.totalCents);
    const next = P.nextTier(total);
    els.barNote.textContent = q.tier.percentOff
      ? `${q.tier.percentOff}% off`
      : next ? `${next.packsNeeded} more for ${next.percentOff}% off` : '';
    els.bar.querySelector('button').setAttribute('aria-label', `Open cart: ${total} ${total === 1 ? 'pack' : 'packs'}, ${money(q.totalCents)}`);

    // Product cards show the price per pack you'd pay with this card's qty added to the cart.
    $$('.flavor-card').forEach((card) => {
      const input = $('[data-qty]', card);
      const addN = clampQty(input.value);
      const t = P.tierFor(total + addN);
      const priceEl = $('[data-card-price]', card);
      priceEl.textContent = money(t.unitCents);
      let was = $('.price-was', card);
      if (t.percentOff) {
        if (!was) {
          was = document.createElement('s');
          was.className = 'price-was';
          priceEl.after(was);
        }
        was.textContent = money(P.BASE_UNIT_CENTS);
      } else if (was) {
        was.remove();
      }
      const save = $('[data-add5-save]', card);
      if (save) save.textContent = `Save ${P.tierFor(total + 5).percentOff}%`;
    });

    if (config.checkoutEnabled === false) showNotice(config.checkoutMessage, false);
  }

  function showNotice(msg, isError) {
    els.notice.hidden = !msg;
    els.notice.textContent = msg || '';
    els.notice.classList.toggle('err', Boolean(isError));
  }

  // Empty-state quick adds
  els.quickAdd.innerHTML = P.FLAVORS.map(
    (f) => `<button type="button" data-quick="${f.id}" data-color="${f.color}">${f.name}<span class="plus">+ Add a pack</span></button>`
  ).join('');

  /* ---------- drawer ---------- */
  const drawer = $('#cart');
  const panel = $('.drawer-panel', drawer);
  const openers = $$('[data-open-cart]');
  let lastFocus = null;

  // While the drawer is open everything behind it is inert (not focusable, hidden from screen readers).
  // The live region stays outside so cart updates are still announced.
  const background = () =>
    Array.from(document.body.children).filter((el) => el !== drawer && !el.matches('[data-cart-live], script, svg, noscript'));
  const setBackgroundInert = (on) => background().forEach((el) => { el.inert = on; });

  function openCart() {
    if (!drawer.hidden && drawer.classList.contains('open')) return;
    const a = document.activeElement;
    lastFocus = a && a !== document.body && !drawer.contains(a) ? a : $('.site-header [data-open-cart]');
    drawer.hidden = false;
    document.documentElement.classList.add('no-scroll');
    setBackgroundInert(true);
    openers.forEach((b) => b.setAttribute('aria-expanded', 'true'));
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      panel.focus({ preventScroll: true });
    });
  }
  function closeCart() {
    if (drawer.hidden) return;
    drawer.classList.remove('open');
    document.documentElement.classList.remove('no-scroll');
    setBackgroundInert(false);
    openers.forEach((b) => b.setAttribute('aria-expanded', 'false'));
    const done = () => {
      if (!drawer.classList.contains('open')) drawer.hidden = true;
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done();
    else setTimeout(done, 320);
    // If the opener was the sticky bar and it is now gone (empty cart), fall back to the header cart button.
    const back = lastFocus && lastFocus.isConnected && lastFocus.offsetParent !== null ? lastFocus : $('.site-header [data-open-cart]');
    if (back && back.focus) back.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => {
    if (drawer.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCart();
      return;
    }
    if (e.key === 'Tab') {
      const f = $$('button:not([disabled]), input, a[href], [tabindex="0"]', panel).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  openers.forEach((b) => b.addEventListener('click', openCart));
  $$('[data-close-cart]').forEach((b) => b.addEventListener('click', closeCart));

  drawer.addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const id = quick.dataset.quick;
      addQty(id, 1);
      const plus = els.lines.querySelector(`[data-line="${id}"] [data-line-step="1"]`);
      if (plus) plus.focus({ preventScroll: true });
      return announce(`Added 1 ${flavorName(id)}.`);
    }
    const line = e.target.closest('[data-line]');
    if (!line) return;
    const id = line.dataset.line;
    const step = e.target.closest('[data-line-step]');
    if (step) {
      const n = (cart[id] || 0) + Number(step.dataset.lineStep);
      setQty(id, n);
      return announce(n > 0 ? `${flavorName(id)}: ${cart[id]}.` : `Removed ${flavorName(id)}.`);
    }
    if (e.target.closest('[data-remove]')) {
      setQty(id, 0);
      return announce(`Removed ${flavorName(id)}.`);
    }
  });
  drawer.addEventListener('change', (e) => {
    const input = e.target.closest('[data-line-qty]');
    if (!input) return;
    const id = input.closest('[data-line]').dataset.line;
    const v = Math.round(Number(input.value));
    setQty(id, Number.isFinite(v) && v > 0 ? clampQty(v) : 0);
    announce(cart[id] ? `${flavorName(id)}: ${cart[id]}.` : `Removed ${flavorName(id)}.`);
  });

  /* ---------- product cards ---------- */
  $$('.flavor-card').forEach((card) => {
    const id = card.dataset.flavor;
    const input = $('[data-qty]', card);
    const addBtn = $('[data-add]', card);
    const add5 = $('[data-add5]', card);
    $$('[data-step]', card).forEach((b) =>
      b.addEventListener('click', () => {
        input.value = clampQty(Number(input.value) + Number(b.dataset.step));
        render();
      })
    );
    input.addEventListener('change', () => {
      input.value = clampQty(input.value);
      render();
    });
    input.addEventListener('input', render);
    const added = (n) => {
      addBtn.classList.add('added');
      addBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> Added';
      setTimeout(() => {
        addBtn.classList.remove('added');
        addBtn.textContent = 'Add to cart';
      }, 1400);
      [...els.count, els.barCount].forEach((c) => {
        c.classList.remove('bump');
        void c.offsetWidth;
        c.classList.add('bump');
      });
      announce(`Added ${n} ${flavorName(id)}.`);
      openCart();
    };
    addBtn.addEventListener('click', () => {
      const n = clampQty(input.value);
      addQty(id, n);
      input.value = 1;
      render();
      added(n);
    });
    if (add5) {
      add5.addEventListener('click', () => {
        addQty(id, 5);
        added(5);
      });
    }
  });

  /* ---------- checkout ---------- */
  els.checkout.addEventListener('click', async () => {
    const its = items();
    if (!its.length) return;
    const label = els.checkout.textContent;
    els.checkout.disabled = true;
    els.checkout.textContent = 'Opening secure checkout…';
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: its }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      if (data.code === 'checkout_unavailable') {
        config.checkoutEnabled = false;
        config.checkoutMessage = data.message;
        showNotice(data.message, false);
      } else {
        showNotice(data.error || 'Checkout hit a snag. Please try again.', true);
      }
    } catch (e) {
      showNotice('Network hiccup. Check your connection and try again.', true);
    }
    els.checkout.disabled = false;
    els.checkout.textContent = label;
  });

  render();

  /* ---------- /#cart (the "Back to your cart" link on /cancel) ---------- */
  function openFromHash() {
    if (location.hash !== '#cart') return;
    history.replaceState(null, '', location.pathname + location.search);
    openCart();
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      config = c;
      render();
    })
    .catch(() => {});
})();
