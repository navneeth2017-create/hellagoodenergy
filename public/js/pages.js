/* Small helpers for the /success and /cancel pages. */
(function () {
  'use strict';
  var STORE_KEY = 'hgg-cart-v1';
  var page = document.body.getAttribute('data-page');

  if (page === 'success') {
    // The order went through: empty the saved cart.
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* storage blocked */ }
    return;
  }

  if (page === 'cancel' && window.HGGPricing) {
    var P = window.HGGPricing;
    var raw = {};
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    var items = P.FLAVORS.filter(function (f) {
      var q = Number(raw[f.id]);
      return Number.isInteger(q) && q > 0;
    }).map(function (f) { return { flavor: f.id, qty: Math.min(Number(raw[f.id]), P.MAX_QTY_PER_FLAVOR) }; });
    if (!items.length) return;
    var q = P.quote(items);
    var el = document.querySelector('[data-saved-cart]');
    var packs = q.totalPacks + (q.totalPacks === 1 ? ' pack' : ' packs');
    var off = q.tier.percentOff ? ' · ' + q.tier.percentOff + '% off' : '';
    el.textContent = 'In your cart: ' + packs + off + ' · ' + P.formatCents(q.totalCents) + ' with shipping';
    el.hidden = false;
  }
})();
