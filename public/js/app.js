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

  /* ---------- rendering ---------- */
  const els = {
    count: $$('[data-cart-count]'),
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

    // Keep focus on a line's quantity field if the user is typing in it.
    const active = document.activeElement;
    const activeLine = active && active.matches('[data-line-qty]') ? active.closest('[data-line]').dataset.line : null;
    els.lines.innerHTML = q.lines.map((l) => lineHtml(l, P.flavorById(l.flavor), q.tier)).join('');
    if (activeLine) {
      const input = els.lines.querySelector(`[data-line="${activeLine}"] [data-line-qty]`);
      if (input) {
        input.focus();
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* number inputs */ }
      }
    }
    els.empty.hidden = total > 0;

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
  let lastFocus = null;

  function openCart() {
    if (!drawer.hidden && drawer.classList.contains('open')) return;
    lastFocus = document.activeElement;
    drawer.hidden = false;
    document.documentElement.classList.add('no-scroll');
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      panel.focus({ preventScroll: true });
    });
  }
  function closeCart() {
    drawer.classList.remove('open');
    document.documentElement.classList.remove('no-scroll');
    const done = () => {
      if (!drawer.classList.contains('open')) drawer.hidden = true;
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done();
    else setTimeout(done, 320);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => {
    if (drawer.hidden) return;
    if (e.key === 'Escape') closeCart();
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

  $$('[data-open-cart]').forEach((b) => b.addEventListener('click', openCart));
  $$('[data-close-cart]').forEach((b) => b.addEventListener('click', closeCart));

  drawer.addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) return addQty(quick.dataset.quick, 1);
    const line = e.target.closest('[data-line]');
    if (!line) return;
    const id = line.dataset.line;
    const step = e.target.closest('[data-line-step]');
    if (step) return setQty(id, (cart[id] || 0) + Number(step.dataset.lineStep));
    if (e.target.closest('[data-remove]')) return setQty(id, 0);
  });
  drawer.addEventListener('change', (e) => {
    const input = e.target.closest('[data-line-qty]');
    if (!input) return;
    const id = input.closest('[data-line]').dataset.line;
    const v = Math.round(Number(input.value));
    setQty(id, Number.isFinite(v) && v > 0 ? clampQty(v) : 0);
  });

  /* ---------- product cards ---------- */
  $$('.flavor-card').forEach((card) => {
    const id = card.dataset.flavor;
    const input = $('[data-qty]', card);
    const addBtn = $('[data-add]', card);
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
    addBtn.addEventListener('click', () => {
      const n = clampQty(input.value);
      addQty(id, n);
      input.value = 1;
      render();
      addBtn.classList.add('added');
      addBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> Added';
      setTimeout(() => {
        addBtn.classList.remove('added');
        addBtn.textContent = 'Add to cart';
      }, 1400);
      els.count.forEach((c) => {
        c.classList.remove('bump');
        void c.offsetWidth;
        c.classList.add('bump');
      });
      openCart();
    });
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

  /* ---------- return from Stripe ---------- */
  function flash(msg, warn) {
    const el = $('[data-flash]');
    el.textContent = msg;
    el.classList.toggle('warn', Boolean(warn));
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 9000);
  }
  const params = new URLSearchParams(location.search);
  const status = params.get('checkout');
  if (status === 'success') {
    cart = {};
    saveCart();
    flash('Order confirmed. Thank you! Your HELLA GOOD! gummies are on the way soon.');
  } else if (status === 'cancelled') {
    flash('Checkout cancelled. Your cart is saved.', true);
  }
  if (status) history.replaceState(null, '', location.pathname + location.hash);

  const year = $('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  render();

  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      config = c;
      render();
    })
    .catch(() => {});
})();
