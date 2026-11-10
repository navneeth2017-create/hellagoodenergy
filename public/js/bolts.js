/* HELLA GOOD! lightning, in three places:
 *  - the hero: jagged bolts in the brand's red, turquoise and orange strike behind the packs;
 *  - Marshawn with the box (cut out of Tom's photo): the same bolts strike behind him and his glow swells;
 *  - "1 Pack": red bolts strike in from the edges of the section at the pack, and its red glow swells (Nav).
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
   *         under reduced motion, onStrike(specs): called with the bolts that just fired,
   *         target: an element inside the host; when given, each bolt's `to` is a fraction of its box instead, so the
   *         bolts land on it at every width }
   */
  function sky(host, svg, opts) {
    if (!host || !host.animate || (svg && !svg.animate)) return;
    let W = 0;
    let H = 0;
    let T = null; // the target's box in host pixels
    let slots = [];
    let timer = 0;
    let running = false;
    let visible = true;
    let last = -1;

    function draw(slot) {
      if (!slot.g) return;
      const s = slot.spec;
      const to = T ? [T.x + s.to[0] * T.w, T.y + s.to[1] * T.h] : [s.to[0] * W, s.to[1] * H];
      const parts = streak([s.from[0] * W, s.from[1] * H], to, 2, opts.jag, []);
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
      T = opts.target ? box(opts.target) : null;
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

    // Where the target sits in the host, by layout: offsets ignore the entrance animation's transform.
    function box(el) {
      let x = 0;
      let y = 0;
      let e = el;
      while (e && e !== host) {
        x += e.offsetLeft;
        y += e.offsetTop;
        e = e.offsetParent;
      }
      if (e === host) return { x, y, w: el.offsetWidth, h: el.offsetHeight };
      const a = el.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
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

  // ---- Marshawn with the box: the hero's lightning, behind him (he is cut out and sits on top), striking in from
  // the sides of his stage toward his shoulders and the box.
  const boxSection = document.querySelector('#the-box');
  sky(document.querySelector('[data-box-sky-host]'), document.querySelector('[data-box-sky]'), {
    colors: { red: '#e8141c', hot: '#ff3b30', turq: '#14c4c0', orange: '#ff7a12' },
    wide: [
      { from: [-0.02, 0.04], to: [0.3, 0.32], c: 'hot', w: 3.4 },
      { from: [1.02, 0.08], to: [0.7, 0.34], c: 'red', w: 3.2 },
      { from: [-0.02, 0.58], to: [0.27, 0.6], c: 'turq', w: 3 },
      { from: [1.02, 0.62], to: [0.73, 0.6], c: 'orange', w: 3 },
      { from: [0.3, -0.02], to: [0.4, 0.16], c: 'red', w: 2.4 },
      { from: [0.72, -0.02], to: [0.6, 0.16], c: 'hot', w: 2.4 },
    ],
    narrow: [
      { from: [-0.02, 0.06], to: [0.3, 0.32], c: 'hot', w: 2.8 },
      { from: [1.02, 0.1], to: [0.7, 0.34], c: 'red', w: 2.6 },
      { from: [-0.02, 0.56], to: [0.27, 0.58], c: 'turq', w: 2.6 },
      { from: [1.02, 0.6], to: [0.73, 0.58], c: 'orange', w: 2.6 },
    ],
    gap: [1200, 1500],
    jag: 0.08,
    still: 3,
    onStrike() {
      if (!boxSection) return;
      boxSection.classList.remove('flash');
      void boxSection.offsetWidth; // restart the glow pulse
      boxSection.classList.add('flash');
    },
  });

  // ---- "1 Pack": red bolts from the edges of the section. Each `to` is a fraction of the pack picture (the pack
  // itself fills about x 0.07-0.83, y 0.11-0.93 of it), so they hit its corners and sides at every width; the pack
  // is solid and sits on top, so a bolt seems to strike it.
  const oneFive = document.querySelector('#one-equals-five');
  sky(oneFive, document.querySelector('[data-one-sky]'), {
    colors: { red: '#e8141c', hot: '#ff3b30' },
    target: document.querySelector('.one-five-media img'),
    wide: [
      { from: [-0.01, 0.02], to: [0.18, 0.2], c: 'hot', w: 3.2 },
      { from: [0.3, -0.02], to: [0.46, 0.15], c: 'red', w: 2.8 },
      { from: [-0.02, 0.5], to: [0.12, 0.52], c: 'red', w: 2.6 },
      { from: [0.06, 1.02], to: [0.24, 0.86], c: 'hot', w: 2.4 },
      { from: [0.5, -0.02], to: [0.8, 0.22], c: 'red', w: 2.6 },
      { from: [0.48, 1.02], to: [0.8, 0.8], c: 'hot', w: 2.4 },
    ],
    narrow: [
      { from: [-0.02, 0.02], to: [0.16, 0.22], c: 'hot', w: 2.6 },
      { from: [1.02, 0.04], to: [0.84, 0.2], c: 'red', w: 2.6 },
      { from: [-0.02, 0.3], to: [0.1, 0.55], c: 'red', w: 2.4 },
      { from: [1.02, 0.34], to: [0.9, 0.62], c: 'hot', w: 2.4 },
      { from: [-0.02, 0.5], to: [0.22, 0.9], c: 'hot', w: 2.2 },
      { from: [1.02, 0.48], to: [0.78, 0.86], c: 'red', w: 2.2 },
    ],
    gap: [1200, 1500],
    jag: 0.07,
    still: 3,
    onStrike() {
      oneFive.classList.remove('flash');
      void oneFive.offsetWidth; // restart the glow pulse
      oneFive.classList.add('flash');
    },
  });
})();
