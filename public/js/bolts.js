/* HELLA GOOD! hero lightning: jagged bolts in the brand's red, blue and orange strike behind the packs, one at a time.
 * Same streak shape as the share image (scripts/build_share_images.py). Strikes are spaced at least 1.2 s apart and
 * each flickers twice, so the page never flashes more than three times a second. Under reduced motion three bolts
 * are drawn once and stay still; without JS the hero keeps its static glow. */
(function () {
  'use strict';

  const hero = document.querySelector('.hero');
  const sky = document.querySelector('[data-sky]');
  if (!hero || !sky || !sky.animate) return;

  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = { red: '#e8141c', hot: '#ff3b30', blue: '#2f6bff', orange: '#ff7a12' };
  // Where bolts strike from and to, as fractions of the hero: out of the edges toward the packs, as on the share image.
  const WIDE = [
    { from: [0.99, -0.02], to: [0.8, 0.5], c: 'hot', w: 3.2 },
    { from: [0.55, -0.02], to: [0.62, 0.42], c: 'red', w: 2.6 },
    { from: [1.01, 0.6], to: [0.86, 1.02], c: 'orange', w: 2.6 },
    { from: [0.47, 1.02], to: [0.58, 0.62], c: 'blue', w: 2.6 },
    { from: [-0.01, 0.05], to: [0.18, 0.3], c: 'red', w: 2.2 },
    { from: [0.75, -0.02], to: [0.7, 0.26], c: 'hot', w: 2 },
  ];
  // On a phone the packs fill the middle, so the bolts stay up around the logo and the tops of the packs.
  const NARROW = [
    { from: [0.2, -0.01], to: [0.34, 0.16], c: 'red', w: 2.2 },
    { from: [1.02, 0.02], to: [0.78, 0.2], c: 'hot', w: 2.4 },
    { from: [-0.02, 0.1], to: [0.18, 0.27], c: 'blue', w: 2.2 },
    { from: [1.02, 0.25], to: [0.85, 0.4], c: 'orange', w: 2.2 },
    { from: [-0.02, 0.3], to: [0.13, 0.42], c: 'red', w: 2 },
  ];

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wide = window.matchMedia('(min-width: 900px)');
  let W = 0;
  let H = 0;
  let slots = [];
  let timer = 0;
  let running = false;
  let visible = true;
  let last = -1;

  /** A jagged streak from p0 to p1 with a few short branches: [main points, [branch points...]]. */
  function streak(p0, p1, depth, out) {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const n = 11;
    const pts = [p0];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const off = (Math.random() * 2 - 1) * len * 0.07;
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
        streak([bx, by], [bx + Math.cos(ang) * bl, by + Math.sin(ang) * bl], depth - 1, out);
      }
    }
    return out;
  }
  const d = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');

  function draw(slot) {
    const s = slot.spec;
    const parts = streak([s.from[0] * W, s.from[1] * H], [s.to[0] * W, s.to[1] * H], 2, []);
    const main = parts.filter((p) => p.depth === 2).map((p) => d(p.pts)).join('');
    const twigs = parts.filter((p) => p.depth < 2).map((p) => d(p.pts)).join('');
    slot.glow.setAttribute('d', main + twigs);
    slot.halo.setAttribute('d', main + twigs);
    slot.core.setAttribute('d', main);
    slot.twig.setAttribute('d', twigs);
  }

  function build() {
    const r = hero.getBoundingClientRect();
    W = Math.round(r.width);
    H = Math.round(r.height);
    sky.setAttribute('viewBox', `0 0 ${W} ${H}`);
    while (sky.lastChild && sky.lastChild.nodeName !== 'defs') sky.removeChild(sky.lastChild);
    slots = (wide.matches ? WIDE : NARROW).map((spec) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'bolt');
      g.style.setProperty('--bolt', COLORS[spec.c]);
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
      sky.appendChild(g);
      return { spec, g, glow, halo, core, twig };
    });
    if (reduce.matches) {
      // Still picture: three bolts, drawn once.
      slots.slice(0, 3).forEach((s) => {
        draw(s);
        s.g.style.opacity = 0.55;
      });
    }
  }

  function flash(s) {
    draw(s);
    s.g.animate(
      [
        { opacity: 0 },
        { opacity: 1, offset: 0.07 },
        { opacity: 0.3, offset: 0.18 },
        { opacity: 0.95, offset: 0.28 },
        { opacity: 0.65, offset: 0.55 },
        { opacity: 0 },
      ],
      { duration: 850, easing: 'ease-out' }
    );
  }

  function strike() {
    if (!slots.length) return;
    let i = Math.floor(Math.random() * slots.length);
    if (i === last) i = (i + 1) % slots.length;
    last = i;
    flash(slots[i]);
    // Now and then a second bolt fires in the same instant (same flicker, so still one flash).
    if (Math.random() < 0.35) flash(slots[(i + 1 + Math.floor(Math.random() * (slots.length - 1))) % slots.length]);
    hero.classList.remove('flash');
    void hero.offsetWidth; // restart the glow pulse
    hero.classList.add('flash');
  }

  function loop() {
    if (!running) return;
    strike();
    timer = setTimeout(loop, 1200 + Math.random() * 1500);
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
      const r = hero.getBoundingClientRect();
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
    }).observe(hero);
  }
})();
