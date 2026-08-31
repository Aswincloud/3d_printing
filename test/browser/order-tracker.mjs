// The order progress tracker in My Orders.
//
// WHY THIS EXISTS. Before this, a customer's order showed one word — and that
// word was the RAW database value, so they read "shipped" and would have read
// "in_production". The tracker replaces it with the six real stages, and what it
// draws has to survive the ways order data actually arrives incomplete: a stage
// skipped (paid -> shipped in one click, still legal), a row that predates the
// timestamp columns, and — found in the live database, not imagined — a row whose
// status is 'shipped' with no shipped_at at all.
//
// stageTimeline() in src/lib.js decides all of that and is unit-tested against
// those cases. What this file checks is the part no server test can: that the
// payload actually becomes a bar with the right steps filled, that it does not
// push the page sideways on a phone, and that a cancelled order gets no tracker.
//
// /api/* is stubbed, so this runs against the static files with no Worker.

import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const WIDTHS = [360, 768];

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const REQUIRE_ALL = process.env.CI === 'true';
const skipped = new Set();

async function launch(engine, name) {
  try {
    return await engine.launch();
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    if (REQUIRE_ALL) {
      console.error(`\n  ${name} could not start, and CI requires it: ${msg}`);
      process.exit(1);
    }
    if (!skipped.has(name)) { skipped.add(name); console.warn(`  !!   skipping ${name}: ${msg}`); }
    return null;
  }
}

// Mirrors what myOrders() returns, including the pre-computed `stages`. The
// shapes are the ones stageTimeline() produces for the awkward cases above.
const stage = (key, label, at, done, current) => ({ key, label, at, done, current });
const TIMELINE = (marks, times = {}) => {
  const defs = [
    ['pending', 'Placed'], ['paid', 'Confirmed'], ['in_production', 'In production'],
    ['ready', 'Ready to ship'], ['shipped', 'Shipped'], ['delivered', 'Delivered'],
  ];
  return defs.map(([k, l], i) =>
    stage(k, l, times[k] ?? null, marks[i] !== '-', marks[i] === '*'));
};

const ORDERS = [
  { receipt: 'AP-mid0001', status: 'in_production', status_label: 'In production',
    total_paise: 129900, created_at: 1785900000000, delivery: 'ship', notes: '',
    items: [{ name: 'Dragon Sculpture', price_paise: 129900, qty: 1 }],
    stages: TIMELINE('xx*---', { pending: 1785900000000, paid: 1785900600000, in_production: 1786000000000 }) },

  { receipt: 'AP-skip002', status: 'shipped', status_label: 'Shipped',
    total_paise: 49900, created_at: 1785800000000, delivery: 'ship', notes: '',
    items: [{ name: 'Batman Figurine', price_paise: 49900, qty: 1 }],
    // Skipped production entirely, and the middle stages carry no time.
    stages: TIMELINE('xxxx*-', { pending: 1785800000000, paid: 1785800600000, shipped: 1785900000000 }) },

  { receipt: 'AP-bare003', status: 'shipped', status_label: 'Shipped',
    total_paise: 34900, created_at: 1785700000000, delivery: 'ship', notes: '',
    items: [{ name: 'Kingfisher', price_paise: 34900, qty: 1 }],
    // The live degenerate row: status only, not one stage timestamp.
    stages: TIMELINE('xxxx*-', { pending: 1785700000000 }) },

  { receipt: 'AP-done004', status: 'delivered', status_label: 'Delivered',
    total_paise: 99900, created_at: 1785600000000, delivery: 'ship', notes: '',
    items: [{ name: 'Elephant Sculpture', price_paise: 99900, qty: 1 }],
    stages: TIMELINE('xxxxx*', { pending: 1785600000000, paid: 1785600600000,
      in_production: 1785700000000, ready: 1785800000000, shipped: 1785900000000, delivered: 1786000000000 }) },

  { receipt: 'AP-gone005', status: 'cancelled', status_label: 'Cancelled',
    total_paise: 19900, created_at: 1785500000000, delivery: 'ship', notes: '',
    items: [{ name: 'Banana Bowl', price_paise: 19900, qty: 1 }],
    // Terminal: ends the pipeline rather than advancing it.
    stages: null },
];

async function stub(page) {
  // Catch-all FIRST: Playwright matches routes in reverse registration order.
  await page.route('**/api/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/products', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ products: [], shipping: { flat_paise: 0, free_threshold_paise: 0 }, promo: null }),
  }));
  await page.route('**/api/me', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ signedIn: true, email: 'buyer@example.com', name: 'Buyer', is_admin: false }),
  }));
  await page.route('**/api/me/orders', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ orders: ORDERS }),
  }));
}

// My Orders lives behind a tab in the account drawer. The tab's real click
// handler is dispatched directly rather than opening the drawer first: that runs
// the genuine path — selectDrawerTab -> loadMyOrders -> myOrderRow — without this
// check depending on a slide-in animation. Nothing test-only is added to the page.
async function openOrders(page) {
  await page.waitForFunction(() => !!document.getElementById('tabOrders'), null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('tabOrders').click());
}

async function run(engine, engineName, width) {
  const b = await launch(engine, engineName);
  if (!b) return;
  const page = await b.newPage();
  await page.setViewportSize({ width, height: 900 });
  await stub(page);
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });

  await openOrders(page);
  await page.waitForSelector('.order-track', { timeout: 10000 });

  const seen = await page.$$eval('.my-order', (cards) => cards.map((c) => {
    const track = c.querySelector('.order-track');
    return {
      receipt: c.querySelector('.my-order-ref')?.firstChild?.textContent?.trim(),
      badge: c.querySelector('.my-order-status')?.textContent?.trim(),
      shape: track ? [...track.querySelectorAll('.order-track-step')].map((s) =>
        s.classList.contains('is-current') ? '*' : s.classList.contains('is-done') ? 'x' : '-').join('') : null,
      times: track ? [...track.querySelectorAll('.order-track-step')]
        .map((s) => (s.querySelector('.order-track-at') ? 'y' : '-')).join('') : null,
    };
  }));

  const by = (r) => seen.find((x) => x.receipt === r) || {};

  ok(`[${engineName} ${width}] mid-pipeline order draws its position`,
     by('AP-mid0001').shape === 'xx*---', JSON.stringify(by('AP-mid0001')));
  ok(`[${engineName} ${width}] a skipped stage still fills the bar`,
     by('AP-skip002').shape === 'xxxx*-', JSON.stringify(by('AP-skip002')));
  ok(`[${engineName} ${width}] the skipped stage shows no invented time`,
     by('AP-skip002').times === 'yy--y-', by('AP-skip002').times);
  ok(`[${engineName} ${width}] a status-only row still fills the bar`,
     by('AP-bare003').shape === 'xxxx*-', JSON.stringify(by('AP-bare003')));
  ok(`[${engineName} ${width}] delivered is complete`,
     by('AP-done004').shape === 'xxxxx*', JSON.stringify(by('AP-done004')));
  ok(`[${engineName} ${width}] a cancelled order gets NO tracker`,
     by('AP-gone005').shape === null, JSON.stringify(by('AP-gone005')));

  // The badge must read like English, never the raw column value.
  ok(`[${engineName} ${width}] badge is the human label`,
     by('AP-mid0001').badge === 'In production', by('AP-mid0001').badge);
  const raw = seen.some((x) => /_/.test(x.badge || ''));
  ok(`[${engineName} ${width}] no raw status leaks into a badge`, !raw,
     JSON.stringify(seen.map((x) => x.badge)));

  // Six labels do not fit a 360px phone. The TRACK may scroll; the page may not.
  const scroll = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    track: [...document.querySelectorAll('.order-track')]
      .some((t) => t.scrollWidth > t.clientWidth),
  }));
  ok(`[${engineName} ${width}] the page does not scroll sideways`, scroll.doc <= 1, String(scroll.doc));

  // The current step must be visually distinguishable, not just class-tagged.
  const distinct = await page.evaluate(() => {
    const cur = document.querySelector('.order-track-step.is-current .order-track-dot');
    const fut = document.querySelector('.order-track-step:not(.is-done) .order-track-dot');
    if (!cur || !fut) return null;
    const a = getComputedStyle(cur), b = getComputedStyle(fut);
    return a.backgroundColor !== b.backgroundColor && a.boxShadow !== 'none';
  });
  ok(`[${engineName} ${width}] the current stage is visibly marked`, distinct === true, String(distinct));

  await b.close();
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  for (const w of WIDTHS) {
    console.log(`\n${name} @ ${w}px`);
    await run(engine, name, w);
  }
}

if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall order-tracker checks passed');
process.exit(fail ? 1 : 0);
