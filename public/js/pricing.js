/*
 * HELLA GOOD! pricing rules — one file shared by the browser (display only)
 * and the server (the source of truth for every charge).
 * All money is in integer cents.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HGGPricing = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE_UNIT_CENTS = 599;
  const SHIPPING_CENTS = 799;
  const MIN_QTY = 1;
  const MAX_QTY_PER_FLAVOR = 100;

  const FLAVORS = Object.freeze([
    { id: 'blue-razz', name: 'Blue Razz', color: 'blue', image: '/images/pack-blue-razz.webp' },
    { id: 'strawberry-lemonade', name: 'Strawberry Lemonade', color: 'red', image: '/images/pack-strawberry-lemonade.webp' },
    { id: 'orange-pineapple-mango', name: 'Orange Pineapple Mango', color: 'orange', image: '/images/pack-orange-pineapple-mango.webp' },
  ]);

  // Highest threshold first. Flavors mix and match toward the tier.
  const TIERS = Object.freeze([
    { minPacks: 15, percentOff: 20 },
    { minPacks: 5, percentOff: 10 },
    { minPacks: 1, percentOff: 0 },
  ]);

  function unitCentsFor(percentOff) {
    return Math.round((BASE_UNIT_CENTS * (100 - percentOff)) / 100);
  }

  function tierFor(totalPacks) {
    for (const t of TIERS) {
      if (totalPacks >= t.minPacks) return { ...t, unitCents: unitCentsFor(t.percentOff) };
    }
    return { minPacks: 0, percentOff: 0, unitCents: BASE_UNIT_CENTS };
  }

  /** The next tier up (or null when already at the top tier). */
  function nextTier(totalPacks) {
    const up = TIERS.filter((t) => t.minPacks > totalPacks && t.percentOff > 0);
    if (!up.length) return null;
    const t = up[up.length - 1];
    return { ...t, unitCents: unitCentsFor(t.percentOff), packsNeeded: t.minPacks - totalPacks };
  }

  function flavorById(id) {
    return FLAVORS.find((f) => f.id === id) || null;
  }

  /**
   * Validate raw input ({items:[{flavor, qty}]}). Returns {ok, items} or {ok:false, error}.
   * Rejects unknown flavors, duplicates, non-integers and quantities outside 1–100 per flavor.
   */
  function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'Your cart is empty.' };
    if (items.length > FLAVORS.length) return { ok: false, error: 'Too many cart lines.' };
    const seen = new Set();
    const clean = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'Invalid cart item.' };
      const flavor = flavorById(item.flavor);
      if (!flavor) return { ok: false, error: 'Unknown flavor.' };
      if (seen.has(flavor.id)) return { ok: false, error: 'Each flavor can appear only once.' };
      seen.add(flavor.id);
      const qty = item.qty;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < MIN_QTY || qty > MAX_QTY_PER_FLAVOR) {
        return { ok: false, error: `Quantity for ${flavor.name} must be a whole number from ${MIN_QTY} to ${MAX_QTY_PER_FLAVOR}.` };
      }
      clean.push({ flavor: flavor.id, qty });
    }
    return { ok: true, items: clean };
  }

  /** Price a validated cart. Shipping is a flat rate per order. */
  function quote(items) {
    const totalPacks = items.reduce((n, i) => n + i.qty, 0);
    const tier = tierFor(totalPacks);
    const lines = items.map((i) => {
      const flavor = flavorById(i.flavor);
      return {
        flavor: flavor.id,
        name: flavor.name,
        qty: i.qty,
        unitCents: tier.unitCents,
        lineCents: tier.unitCents * i.qty,
      };
    });
    const subtotalCents = lines.reduce((n, l) => n + l.lineCents, 0);
    const listCents = totalPacks * BASE_UNIT_CENTS;
    const shippingCents = totalPacks > 0 ? SHIPPING_CENTS : 0;
    return {
      totalPacks,
      tier,
      next: nextTier(totalPacks),
      lines,
      listCents,
      savingsCents: listCents - subtotalCents,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
    };
  }

  function nudge(totalPacks) {
    const n = nextTier(totalPacks);
    if (totalPacks <= 0) return 'Mix any 5 packs to save 10%. 15+ packs saves 20%.';
    if (!n) return `You're saving 20%, the best price per pack.`;
    const packs = n.packsNeeded === 1 ? '1 more pack' : `${n.packsNeeded} more packs`;
    return `Add ${packs} to save ${n.percentOff}%.`;
  }

  function formatCents(c) {
    return '$' + (c / 100).toFixed(2);
  }

  return {
    BASE_UNIT_CENTS,
    SHIPPING_CENTS,
    MIN_QTY,
    MAX_QTY_PER_FLAVOR,
    FLAVORS,
    TIERS,
    unitCentsFor,
    tierFor,
    nextTier,
    flavorById,
    validateItems,
    quote,
    nudge,
    formatCents,
  };
});
