// The grid grows as you scroll.
//
// WHY THIS EXISTS. The catalogue used to end in a "Show 12 more" button. It now
// ends in a sentinel: scroll to it and the next twelve cards append themselves.
// The button existed for a reason that still holds — 109 cards at once is a
// 30,000px page with the quote form 27,000px down — so the page-at-a-time SHAPE
// is what these checks pin, with the click removed.
//
// IntersectionObserver timing differs between engines, so this runs in both.
// Auth and the catalogue are stubbed; 40 products, well past one page.

import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const REQUIRE_ALL = process.env.CI === 'true';
const skipped = new Set();
async function launch(engine, name) {
  try { return await engine.launch(); } catch (e) {
    const msg = String(e.message).split('\n')[0];
    if (REQUIRE_ALL) { console.error(`\n  ${name} could not start, and CI requires it: ${msg}`); process.exit(1); }
    if (!skipped.has(name)) { skipped.add(name); console.warn(`  !!   skipping ${name}: ${msg}`); }
    return null;
  }
}

const N = 40, PAGE = 12;
// Category split is deliberate: 'decor' gets HALF the catalogue (20 of 40), so
// filtering to it still overflows one page. With an even split (10 each) the
// filter-reset check could not fail — 10 fits in one page whether or not the
// limit was reset, and the first version of this file proved exactly that.
const cats = ['decor', 'figurine', 'decor', 'set'];
const PRODUCTS = {
  products: Array.from({ length: N }, (_, i) => ({
    id: 'p' + i, slug: 's' + i, name: 'Product ' + String(i).padStart(2, '0'), description: '',
    price_paise: 49900 + i * 100, quote_only: false, image: 'assets/images/placeholder.jpg', images: [],
    category: cats[i % 4], personalise_label: '', personalise_required: false, pinned: false, compare_at_paise: null,
  })),
  shipping: { flat_paise: 9900, free_threshold_paise: 200000 }, promo: null,
};

async function run(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await b.newPage();
  await p.setViewportSize({ width: 390, height: 844 });
  await p.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await p.route('**/api/products', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRODUCTS) }));
  await p.route('**/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
  await p.route(/\/(cdn-cgi\/image|assets\/images)\//, (r) => r.fulfill({ status: 200, contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForSelector('.product-card', { timeout: 15000 });

  const cards = () => p.evaluate(() => document.querySelectorAll('#productGrid .product-card').length);
  const countText = () => p.evaluate(() => document.querySelector('.shop-more-count')?.textContent ?? '');

  ok(`[${name}] first paint is one page, not the whole catalogue`, (await cards()) === PAGE, String(await cards()));
  ok(`[${name}] there is no button to click`, (await p.$('#shopMoreBtn')) === null);
  ok(`[${name}] the count line says where you are`, /Showing 12 of 40/.test(await countText()), await countText());

  // Scroll the sentinel into view: the next page must appear with no click.
  await p.evaluate(() => document.querySelector('.shop-more-sentinel')?.scrollIntoView());
  await p.waitForFunction((n) => document.querySelectorAll('#productGrid .product-card').length > n, PAGE, { timeout: 5000 }).catch(() => {});
  const after1 = await cards();
  ok(`[${name}] scrolling to the end loads the next page`, after1 === PAGE * 2, String(after1));
  ok(`[${name}] exactly one page at a time, not everything`, after1 < N, String(after1));

  // Keep scrolling to the end: every card arrives, then the sentinel goes away.
  for (let i = 0; i < 8; i++) {
    const before = await cards();
    if (before >= N) break;
    await p.evaluate(() => document.querySelector('.shop-more-sentinel')?.scrollIntoView());
    await p.waitForFunction((n) => document.querySelectorAll('#productGrid .product-card').length > n, before, { timeout: 5000 }).catch(() => {});
  }
  ok(`[${name}] every product is reachable by scrolling alone`, (await cards()) === N, String(await cards()));
  ok(`[${name}] the sentinel is gone once everything is shown`, (await p.$('.shop-more-sentinel')) === null);
  // Below the grid, and reachable by scrolling — the whole reason the grid is
  // paged. `behavior: 'instant'`: the document has scroll-behavior: smooth, so a
  // plain scrollIntoView() animates for ~400ms and a rect read before it lands
  // reports a position mid-flight. That is how this check first failed.
  await p.evaluate(() => document.getElementById('quote')?.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await p.waitForTimeout(100);
  const quote = await p.evaluate(() => { const r = document.getElementById('quote')?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null; });
  ok(`[${name}] the quote form is still below the grid and reachable`,
     !!quote && quote.top < 844 && quote.bottom > 0, JSON.stringify(quote));

  // A filter starts back at the first page — the sentinel must not have broken
  // the reset that keyed on the filter state.
  await p.evaluate(() => document.querySelector('.filter-btn[data-category="decor"]')?.click());
  await p.waitForTimeout(300);
  const filtered = await cards();
  const decorTotal = PRODUCTS.products.filter((x) => x.category === 'decor').length;
  ok(`[${name}] the filter has more than one page to show (${decorTotal} decor)`, decorTotal > PAGE, String(decorTotal));
  ok(`[${name}] a filter resets to the first page`, filtered === PAGE, `${filtered} shown, wanted exactly ${PAGE}`);

  await b.close();
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  console.log(`\n${name}`);
  await run(engine, name);
}
if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall shop-autoload checks passed');
process.exit(fail ? 1 : 0);
