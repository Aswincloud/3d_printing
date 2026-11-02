// Fireworks over the seasonal offer (index.html #offer) — 2026-11-02.
//
// A short celebratory show when the offer first scrolls into view, and a burst
// each time "Copy code" is pressed. Deliberately small:
//   - one <canvas> inside the offer box, pointer-events:none, so it can never
//     cover a button;
//   - runs only while the offer is shown and on screen, and only for a few
//     seconds — then the animation loop stops entirely (no idle CPU or battery);
//   - nothing at all for visitors with prefers-reduced-motion;
//   - no library, no network, and it fails silently: a missing canvas or a
//     hidden offer simply means no fireworks.
(function () {
  const offer = document.getElementById('offer');
  const box = offer && offer.querySelector('.offer-inner');
  if (!box) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce && reduce.matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'offer-fireworks';
  canvas.setAttribute('aria-hidden', 'true');
  box.prepend(canvas);
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  const COLOURS = ['#ffcf6b', '#ff8c38', '#ff6b00', '#ffd08a', '#ff4d6d', '#7cf5ff', '#b48cff'];
  const particles = [];
  const rockets = [];
  let raf = 0, w = 0, h = 0, dpr = 1, showUntil = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = box.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  // Bursts scale with the box: a 1600px desktop box gets bigger, fuller ones than
  // a phone. Two colours per burst, and a few slower sparks that twinkle.
  function burst(x, y) {
    const c1 = COLOURS[(Math.random() * COLOURS.length) | 0];
    const c2 = COLOURS[(Math.random() * COLOURS.length) | 0];
    const scale = Math.max(1, Math.min(2.2, w / 520));
    const n = Math.round((44 + Math.random() * 22) * Math.min(scale, 1.6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.06, 0.06);
      const v = rand(1.6, 3.6) * scale;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(55, 85), age: 0,
        colour: i % 3 ? c1 : c2, r: rand(1.5, 2.6), twinkle: Math.random() < 0.25 });
    }
    start();
  }

  function launch() {
    rockets.push({ x: rand(w * 0.1, w * 0.9), y: h + 4, vy: -rand(5.4, 7.2), target: rand(h * 0.1, h * 0.42), trail: [] });
    start();
  }

  function step() {
    raf = 0;
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    // More rockets on a wide box, so a desktop banner is not one lonely spark.
    if (now < showUntil && Math.random() < 0.05 * Math.max(1, Math.min(2.5, w / 600))) launch();

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.trail.push(r.y); if (r.trail.length > 10) r.trail.shift();
      r.y += r.vy; r.vy += 0.08;
      // A fading streak rather than a single dash, so it reads as a rocket.
      for (let t = 0; t < r.trail.length; t++) {
        ctx.globalAlpha = (t + 1) / r.trail.length * 0.7;
        ctx.fillStyle = '#ffe2a8';
        ctx.fillRect(r.x - 1, r.trail[t], 2, 3);
      }
      ctx.globalAlpha = 1;
      if (r.y <= r.target || r.vy >= 0) { rockets.splice(i, 1); burst(r.x, r.y); }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age++; p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.035;
      const fade = 1 - p.age / p.life;
      if (fade <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.twinkle ? fade * (0.55 + 0.45 * Math.sin(p.age * 0.6)) : fade;
      ctx.fillStyle = p.colour;
      ctx.shadowColor = p.colour; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // Keep going only while there is something to draw or the show is on.
    if (particles.length || rockets.length || now < showUntil) raf = requestAnimationFrame(step);
  }

  function start() { if (!raf && !offer.hidden) raf = requestAnimationFrame(step); }

  // A show: a few seconds of rockets, opening with a burst so it is seen at once.
  function show(ms) {
    if (offer.hidden) return;
    size();
    showUntil = performance.now() + ms;
    burst(w * 0.2, h * 0.32); burst(w * 0.8, h * 0.28); burst(w * 0.5, h * 0.18);
    start();
  }

  // First time the offer is on screen: a 5-second show. Once per page view.
  let shown = false;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries, io) => {
      if (entries.some((e) => e.isIntersecting) && !shown && !offer.hidden) {
        shown = true; io.disconnect(); show(5000);
      }
    }, { threshold: 0.4 }).observe(box);
  }

  // A burst when the code is copied — the moment worth celebrating.
  const copy = document.getElementById('offerCopy');
  if (copy) copy.addEventListener('click', () => { size(); burst(w * 0.5, h * 0.35); burst(w * 0.3, h * 0.5); burst(w * 0.7, h * 0.5); });

  window.addEventListener('resize', () => { if (raf) size(); });
  // Turning reduce-motion on mid-visit stops it at once.
  if (reduce && reduce.addEventListener) reduce.addEventListener('change', (e) => { if (e.matches) { showUntil = 0; particles.length = 0; rockets.length = 0; ctx.clearRect(0, 0, w, h); } });
})();
