// The three hero photos must sit wholly inside the hero — with the sale offer
// above it (since #100) and without (a non-sale day).
//
// WHY THIS EXISTS. On desktop the photo stack is absolutely positioned. It was
// centred on the first screen, which is right only when the hero opens the page.
// Once the Diwali offer moved above the hero, the stack hung ~160px past the
// hero's bottom and the hero's overflow:hidden cut it off: Batman lost his legs
// and the third photo vanished — at every desktop width.
//
// The offer is filled and un-hidden by the Worker; a static server cannot do
// that, so this test fills it the same way the Worker would before measuring.
import { chromium, webkit } from 'playwright';
import { offline } from './_offline.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SIZES = [[1280, 820], [1440, 900], [1920, 1080], [1100, 700], [1024, 768], [768, 1024], [390, 844]];
const REQUIRE_ALL = process.env.CI === 'true';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

async function measure(page, withOffer) {
  await page.evaluate((show) => {
    const o = document.getElementById('offer');
    const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    if (show) {
      set('offerKicker', "🪔 Let's celebrate Diwali with us!");
      set('offerTitle', '26% off everything in the shop');
      set('offerTerms', 'up to ₹100 off · one use per customer · free shipping on every order');
      set('offerCode', 'DIWALI26'); set('offerEnds', 'Ends 30 Nov');
      const g = document.getElementById('offerGift');
      if (g) { g.textContent = '🎁 Orders of ₹999 and above get a free 3D-printed surprise gift'; g.hidden = false; }
    }
    o.hidden = !show;
    window.scrollTo(0, 0);
  }, withOffer);
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const hero = document.getElementById('home').getBoundingClientRect();
    const tiles = [...document.querySelectorAll('.hero-visual .hero-shot')].map((e) => e.getBoundingClientRect());
    const out = tiles.map((t) => Math.max(0, hero.top - t.top) + Math.max(0, t.bottom - hero.bottom));
    return { tiles: tiles.length, worst: Math.round(Math.max(0, ...out)), overflowX: document.documentElement.scrollWidth > innerWidth };
  });
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  let b;
  try { b = await engine.launch(); }
  catch (e) {
    if (REQUIRE_ALL) { console.error(`${name} could not start, and CI requires it`); process.exit(1); }
    console.warn(`  !! ${name} did not run`); continue;
  }
  console.log(`\n${name}`);
  for (const [w, h] of SIZES) {
    const page = await b.newPage({ viewport: { width: w, height: h } });
    await offline(page);
    await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    for (const withOffer of [true, false]) {
      const r = await measure(page, withOffer);
      const label = `[${name} ${w}x${h}] ${withOffer ? 'offer above' : 'no sale'}`;
      ok(`${label}: all 3 photos inside the hero`, r.tiles === 3 && r.worst === 0, `tiles=${r.tiles}, worst overhang ${r.worst}px`);
      ok(`${label}: no sideways scroll`, !r.overflowX);
    }
    await page.close();
  }
  await b.close();
}
console.log(fail ? `\n${fail} failed` : '\nall hero-photos checks passed');
process.exit(fail ? 1 : 0);
