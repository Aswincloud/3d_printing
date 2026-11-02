// Fireworks over the sale offer (public/assets/js/fireworks.js) must celebrate
// without getting in the way:
//   - they draw while the show runs and STOP afterwards (no idle animation loop);
//   - the text and buttons stay on top and clickable;
//   - Copy code sets off a burst;
//   - nothing at all with prefers-reduced-motion, and nothing when no sale is on.
// The offer is un-hidden by the Worker in production; here the test does it, as
// test/browser/hero-photos.mjs does.
import { chromium, webkit } from 'playwright';
import { offline } from './_offline.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const REQUIRE_ALL = process.env.CI === 'true';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const painted = (p) => p.evaluate(() => {
  const c = document.querySelector('.offer-fireworks'); if (!c || !c.width) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n;
});

async function open(b, opts, showOffer) {
  const p = await b.newPage(opts);
  await offline(p);
  await p.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
  // The page re-checks the offer against /api/products' promo (syncOffer in
  // main.js) and hides it if none is live — so on a sale day that API says so.
  if (showOffer) await p.route('**/api/products', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ products: [], shipping: { flat_paise: 0, free_threshold_paise: 200000 }, sales: [],
      promo: { code: 'DIWALI26', kind: 'percent', value: 26, max_discount_paise: 10000, min_order_paise: 0, once_per_customer: true, label: "🪔 Let's celebrate Diwali with us!", expires_at: Date.now() + 86400000 } }) }));
  // Serve the page the way the Worker does on a sale day: the offer already
  // un-hidden and filled IN THE HTML, before any script runs.
  if (showOffer) await p.route('**/index.html', async (r) => {
    const res = await r.fetch();
    let html = await res.text();
    html = html.replace('<section class="offer" id="offer" aria-labelledby="offerTitle" hidden>', '<section class="offer" id="offer" aria-labelledby="offerTitle" data-promo-code="DIWALI26">')
      .replace('<p class="offer-kicker" id="offerKicker"></p>', '<p class="offer-kicker" id="offerKicker">🪔 Let\'s celebrate Diwali with us!</p>')
      .replace('<h2 class="offer-title" id="offerTitle"></h2>', '<h2 class="offer-title" id="offerTitle">26% off everything in the shop</h2>')
      .replace('<span class="offer-code" id="offerCode"></span>', '<span class="offer-code" id="offerCode">DIWALI26</span>')
      .replace('<p class="offer-ends" id="offerEnds"></p>', '<p class="offer-ends" id="offerEnds">Ends 30 Nov</p>');
    await r.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
  });
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  return p;
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  let b;
  try { b = await engine.launch(); }
  catch { if (REQUIRE_ALL) { console.error(`${name} could not start, and CI requires it`); process.exit(1); } console.warn(`  !! ${name} did not run`); continue; }
  console.log(`\n${name}`);
  for (const [w, h] of [[1280, 820], [390, 844]]) {
    const p = await open(b, { viewport: { width: w, height: h } }, true);
    await p.waitForTimeout(900);
    ok(`[${name} ${w}] fireworks draw during the show`, (await painted(p)) > 50, String(await painted(p)));
    await p.evaluate(() => document.getElementById('offerCopy').scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(200);
    const top = await p.evaluate(() => { const r = document.getElementById('offerCopy').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e ? (e.id || e.tagName + '.' + e.className) + ' @' + Math.round(r.top) + '/' + innerHeight : 'none'; });
    ok(`[${name} ${w}] the Copy button stays on top`, String(top).startsWith('offerCopy'), String(top));
    await p.waitForTimeout(7500);
    ok(`[${name} ${w}] the show ends and the canvas is clear`, (await painted(p)) === 0, String(await painted(p)));
    await p.click('#offerCopy'); await p.waitForTimeout(250);
    ok(`[${name} ${w}] Copy code sets off a burst`, (await painted(p)) > 50);
    await p.close();
  }
  const r = await open(b, { viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' }, true);
  await r.waitForTimeout(900);
  ok(`[${name}] reduced motion: no fireworks at all`, !(await r.evaluate(() => document.querySelector('.offer-fireworks'))));
  await r.close();
  const n = await open(b, { viewport: { width: 1280, height: 820 } }, false);
  await n.waitForTimeout(900);
  ok(`[${name}] no sale on: nothing drawn`, (await painted(n)) <= 0);
  await n.close();
  await b.close();
}
console.log(fail ? `\n${fail} failed` : '\nall offer-fireworks checks passed');
process.exit(fail ? 1 : 0);
