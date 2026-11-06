/* HELLA GOOD! lightning, in two places:
 *  - the hero: jagged bolts in the brand's red, turquoise and orange strike behind the packs;
 *  - Tom's photo of Marshawn with the box: the photo's own lightning flares, one side and one spot at a time, so it
 *    flickers from branch to branch (no drawn bolts there: they looked pasted on next to the real ones).
 * Same streak shape as the share image (scripts/build_share_images.py). Strikes are spaced at least 0.9 s apart and
 * each flickers twice, so neither place flashes more than three times a second. A sky only strikes while it is on
 * screen and the tab is visible. Under reduced motion a few bolts are drawn once and stay still; without JS both keep
 * their static look. */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wide = window.matchMedia('(min-width: 900px)');
  const d = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  // A strike: bright, a dip, bright again, then fading out (two flickers in 850 ms).
  const FLICKER = [
    { opacity: 0 },
    { opacity: 1, offset: 0.07 },
    { opacity: 0.3, offset: 0.18 },
    { opacity: 0.95, offset: 0.28 },
    { opacity: 0.65, offset: 0.55 },
    { opacity: 0 },
  ];

  /** A jagged streak from p0 to p1 with a few short branches: [{ pts, depth }...]. */
  function streak(p0, p1, depth, jag, out) {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const n = 11;
    const pts = [p0];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const off = (Math.random() * 2 - 1) * len * jag;
      pts.push([p0[0] + dx * t + nx * off, p0[1] + dy * t + ny * off]);
    }
    pts.push(p1);
    out.push({ pts, depth });
    if (depth > 0) {
      const count = depth === 2 ? 3 : 1;
      for (let b = 0; b < count; b++) {
        const i = 2 + Math.floor(Math.random() * (n - 3));
        const [bx, by] = pts[i];
        const ang = Math.atan2(dy, dx) + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.5);
        const bl = len * (0.18 + Math.random() * 0.14);
        streak([bx, by], [bx + Math.cos(ang) * bl, by + Math.sin(ang) * bl], depth - 1, jag, out);
      }
    }
    return out;
  }

  /**
   * One lightning sky: `svg` covers `host`; bolts go from/to fractions of the host's box. Without an `svg` nothing is
   * drawn and the strikes only drive onStrike.
   * opts: { colors, wide: [spec], narrow: [spec], gap: [min ms, extra random ms], jag, still: how many bolts to draw
   *         under reduced motion, onStrike(specs): called with the bolts that just fired }
   */
  function sky(host, svg, opts) {
    if (!host || !host.animate || (svg && !svg.animate)) return;
    let W = 0;
    let H = 0;
    let slots = [];
    let timer = 0;
    let running = false;
    let visible = true;
    let last = -1;

    function draw(slot) {
      if (!slot.g) return;
      const s = slot.spec;
      const parts = streak([s.from[0] * W, s.from[1] * H], [s.to[0] * W, s.to[1] * H], 2, opts.jag, []);
      const main = parts.filter((p) => p.depth === 2).map((p) => d(p.pts)).join('');
      const twigs = parts.filter((p) => p.depth < 2).map((p) => d(p.pts)).join('');
      slot.glow.setAttribute('d', main + twigs);
      slot.halo.setAttribute('d', main + twigs);
      slot.core.setAttribute('d', main);
      slot.twig.setAttribute('d', twigs);
    }

    function build() {
      const r = host.getBoundingClientRect();
      W = Math.round(r.width);
      H = Math.round(r.height);
      const specs = wide.matches ? opts.wide : opts.narrow;
      if (!svg) {
        slots = specs.map((spec) => ({ spec }));
        return;
      }
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      while (svg.lastChild && svg.lastChild.nodeName !== 'defs') svg.removeChild(svg.lastChild);
      slots = specs.map((spec) => {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'bolt');
        g.style.setProperty('--bolt', opts.colors[spec.c]);
        const glow = document.createElementNS(NS, 'path');
        glow.setAttribute('class', 'bolt-glow');
        const halo = document.createElementNS(NS, 'path');
        halo.setAttribute('class', 'bolt-halo');
        halo.style.strokeWidth = spec.w * 2.2;
        const core = document.createElementNS(NS, 'path');
        core.setAttribute('class', 'bolt-core');
        core.style.strokeWidth = spec.w;
        const twig = document.createElementNS(NS, 'path');
        twig.setAttribute('class', 'bolt-core');
        twig.style.strokeWidth = spec.w * 0.55;
        g.append(glow, halo, core, twig);
        svg.appendChild(g);
        return { spec, g, glow, halo, core, twig };
      });
      if (reduce.matches) {
        // Still picture: a few bolts, drawn once.
        slots.slice(0, opts.still).forEach((s) => {
          draw(s);
          s.g.style.opacity = 0.55;
        });
      }
    }

    function flash(s) {
      if (!s.g) return;
      draw(s);
      s.g.animate(FLICKER, { duration: 850, easing: 'ease-out' });
    }

    function strike() {
      if (!slots.length) return;
      let i = Math.floor(Math.random() * slots.length);
      if (i === last) i = (i + 1) % slots.length;
      last = i;
      const fired = [slots[i]];
      // Now and then a second bolt fires in the same instant (same flicker, so still one flash).
      if (Math.random() < 0.35) fired.push(slots[(i + 1 + Math.floor(Math.random() * (slots.length - 1))) % slots.length]);
      fired.forEach(flash);
      if (opts.onStrike) opts.onStrike(fired.map((s) => s.spec));
    }

    function loop() {
      if (!running) return;
      strike();
      timer = setTimeout(loop, opts.gap[0] + Math.random() * opts.gap[1]);
    }
    function update() {
      const want = visible && !document.hidden && !reduce.matches;
      if (want === running) return;
      running = want;
      clearTimeout(timer);
      if (running) timer = setTimeout(loop, 500);
    }

    build();
    update();

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const r = host.getBoundingClientRect();
        if (Math.round(r.width) !== W || Math.round(r.height) !== H) build();
      }, 150);
    });
    document.addEventListener('visibilitychange', update);
    const onReduce = () => {
      build();
      running = false;
      update();
    };
    if (reduce.addEventListener) reduce.addEventListener('change', onReduce);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        update();
      }).observe(host);
    }
  }

  // ---- The hero. Where bolts strike from and to, as fractions of the hero: out of the edges toward the packs,
  // as on the share image. On a phone the packs fill the middle, so the bolts stay up around the logo and the tops
  // of the packs.
  const hero = document.querySelector('.hero');
  sky(hero, document.querySelector('[data-sky]'), {
    colors: { red: '#e8141c', hot: '#ff3b30', turq: '#14c4c0', orange: '#ff7a12' },
    wide: [
      { from: [0.99, -0.02], to: [0.8, 0.5], c: 'hot', w: 3.2 },
      { from: [0.55, -0.02], to: [0.62, 0.42], c: 'red', w: 2.6 },
      { from: [1.01, 0.6], to: [0.86, 1.02], c: 'orange', w: 2.6 },
      { from: [0.47, 1.02], to: [0.58, 0.62], c: 'turq', w: 2.6 },
      { from: [-0.01, 0.05], to: [0.18, 0.3], c: 'red', w: 2.2 },
      { from: [0.75, -0.02], to: [0.7, 0.26], c: 'hot', w: 2 },
    ],
    narrow: [
      { from: [0.2, -0.01], to: [0.34, 0.16], c: 'red', w: 2.2 },
      { from: [1.02, 0.02], to: [0.78, 0.2], c: 'hot', w: 2.4 },
      { from: [-0.02, 0.1], to: [0.18, 0.27], c: 'turq', w: 2.2 },
      { from: [1.02, 0.25], to: [0.85, 0.4], c: 'orange', w: 2.2 },
      { from: [-0.02, 0.3], to: [0.13, 0.42], c: 'red', w: 2 },
    ],
    gap: [1200, 1500],
    jag: 0.07,
    still: 3,
    onStrike() {
      hero.classList.remove('flash');
      void hero.offsetWidth; // restart the glow pulse
      hero.classList.add('flash');
    },
  });

  // ---- Marshawn with the box: each strike flares the photo's lightning around a random spot on one side (the
  // lightning fans out from behind his shoulders and arms, so the spots stay off him).
  const box = document.querySelector('[data-box-sky-host]');
  const layers = {};
  document.querySelectorAll('[data-box-bolts]').forEach((el) => (layers[el.dataset.boxBolts] = el));
  const sides = [{ side: 'l' }, { side: 'r' }, { side: 'l' }, { side: 'r' }];
  sky(box, null, {
    wide: sides,
    narrow: sides,
    gap: [1000, 1200], // two flickers per strike, at least 1 s apart: never more than three flashes a second
    onStrike(specs) {
      new Set(specs.map((s) => s.side)).forEach((side) => {
        const el = layers[side];
        if (!el || !el.animate) return;
        const x = side === 'l' ? 8 + Math.random() * 30 : 62 + Math.random() * 30;
        el.style.setProperty('--mx', x.toFixed(1) + '%');
        el.style.setProperty('--my', (12 + Math.random() * 74).toFixed(1) + '%');
        el.animate(FLICKER, { duration: 850, easing: 'ease-out' });
      });
    },
  });
})();
