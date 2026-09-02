// The site on a phone. (Named for checkout, where it started; it now also covers
// touch targets and field sizes across the whole page.)
//
// WHY THIS EXISTS. Defects reported from a real phone, then a measured sweep that
// found more of the same kind. All of them were invisible on a desktop, which is
// the whole reason this runs at phone widths rather than one.
//
// It began as checkout-only. Two of those defects came from one rule:
//
//   @media (max-width: 480px) { .btn-primary, .btn-secondary { width: 100% } }
//
// That exists to stack hero CTAs full-width. But the promo Apply button is a
// .btn-secondary too, and it also carries `flex: 0 0 auto` — so it took the
// whole row and refused to shrink, collapsing the promo input to its 31px
// minimum. Measured before the fix: the input was 31px at 360, 390 AND 430px
// while the button was 100% of the row. Desktop was fine, which is why it
// shipped.
//
// The second: every checkout field was 15.2px, and iOS Safari zooms the viewport
// when focusing any input under 16px — so tapping a field on the one page where
// precision matters left the customer zoomed and scrolled sideways.
//
// This file asserts PROPORTIONS and the 16px floor rather than exact pixels, so
// it survives a redesign and only fails when the layout genuinely breaks again.

import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const PHONES = [360, 390, 430];

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

const product = (id, slug, name, price) => ({
  id, slug, name, description: '', price_paise: price, quote_only: false,
  image: 'assets/images/placeholder.jpg', images: [], category: 'figurine',
  personalise_label: '', personalise_required: false, pinned: false });

const PRODUCTS = {
  products: [product('p1', 'dragon', 'Dragon Sculpture', 129900),
             product('p2', 'batman', 'Batman Figurine', 44900)],
  shipping: { flat_paise: 9900, free_threshold_paise: 200000 }, promo: null };

async function page(b, width) {
  const p = await b.newPage();
  await p.setViewportSize({ width, height: 900 });
  await p.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await p.route('**/api/products', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRODUCTS) }));
  await p.route('**/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
  await p.addInitScript(() => localStorage.setItem('ap_cart', JSON.stringify([{ id: 'p1', qty: 1, pz: '' }])));
  return p;
}

async function openCheckout(p) {
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForSelector('.product-card', { timeout: 15000 });
  await p.evaluate(() => document.getElementById('cartBtn')?.click());
  await p.waitForFunction(() => !!document.getElementById('cartCheckout'), null, { timeout: 5000 });
  await p.evaluate(() => document.getElementById('cartCheckout')?.click());
  await p.waitForFunction(() => {
    const i = document.getElementById('coPromo');
    return i && i.getBoundingClientRect().width > 0;
  }, null, { timeout: 5000 });
}

async function promoRow(engine, name, width) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await page(b, width);
  await openCheckout(p);

  const m = await p.evaluate(() => {
    const i = document.getElementById('coPromo');
    const btn = document.getElementById('coPromoApply');
    const row = document.querySelector('.co-promo-row');
    const W = (e) => e.getBoundingClientRect().width;
    return {
      row: W(row), input: W(i), button: W(btn),
      inputShare: W(i) / W(row),
      sameLine: Math.abs(i.getBoundingClientRect().top - btn.getBoundingClientRect().top) < 4,
      font: parseFloat(getComputedStyle(i).fontSize),
      overflow: (W(i) + W(btn)) - W(row),
    };
  });

  // THE BUG: the input was 11% of the row. A promo code needs to be readable
  // while it is typed, so it must own the majority of the row.
  ok(`[${name} ${width}] the input gets most of the row`,
     m.inputShare > 0.55, `${Math.round(m.inputShare * 100)}% (input ${Math.round(m.input)}px of ${Math.round(m.row)}px)`);
  // And the button must stay a button, not a banner.
  ok(`[${name} ${width}] the Apply button is bounded`,
     m.button >= 60 && m.button <= 130, `${Math.round(m.button)}px`);
  ok(`[${name} ${width}] both sit on one line`, m.sameLine, JSON.stringify(m));
  ok(`[${name} ${width}] they fit the row`, m.overflow <= 10, `overflow ${Math.round(m.overflow)}px`);

  // iOS Safari zooms the page on focus for anything under 16px.
  ok(`[${name} ${width}] the promo input will not trigger iOS focus-zoom`,
     m.font >= 16, `${m.font}px`);

  const fonts = await p.$$eval('.co-field input, .co-field textarea',
    (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  ok(`[${name} ${width}] no checkout field will trigger iOS focus-zoom`,
     fonts.every((f) => f >= 16), JSON.stringify(fonts));

  // The whole point of a phone check: nothing may push the document sideways.
  const docScroll = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`[${name} ${width}] checkout does not scroll the page sideways`, docScroll <= 1, String(docScroll));

  await b.close();
}

// Desktop must NOT be dragged to 16px — the smaller field size is deliberate
// there, and iOS focus-zoom does not exist.
async function desktopUntouched(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await page(b, 1280);
  await openCheckout(p);
  const font = await p.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById('coPromo')).fontSize));
  ok(`[${name} 1280] desktop keeps its smaller field size`, font < 16, `${font}px`);
  await b.close();
}

// The other half of the product page's cart button: it links to /#cart, and the
// homepage has to answer that by opening the drawer. Asserted here because the
// link is server-rendered (covered in test/pdp.mjs) but the RESPONSE is not.
async function cartHash(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await page(b, 390);
  await p.goto(BASE + '/index.html#cart', { waitUntil: 'load' });
  await p.waitForSelector('.product-card', { timeout: 15000 });
  await p.waitForTimeout(600);
  const m = await p.evaluate(() => {
    const d = document.querySelector('.cart-drawer');
    return { open: !!d && d.classList.contains('open'),
             hash: location.hash,
             hasItem: (document.getElementById('cartBody')?.textContent || '').includes('Dragon') };
  });
  ok(`[${name}] arriving at #cart opens the drawer`, m.open, JSON.stringify(m));
  ok(`[${name}] with the cart's contents in it`, m.hasItem, JSON.stringify(m));
  // Cleared so a refresh does not reopen it, matching how #checkout behaves.
  ok(`[${name}] and the hash is cleared`, m.hash === '', m.hash);
  await b.close();
}

// The badge must agree with the drawer under it.
//
// renderCart() drops any line whose product has left the catalogue, but the badge
// counted raw lines — so a cart holding one delisted item and one real one showed
// "2" above a drawer listing one. Found on production, after the cart button on
// the product page made the badge something people would actually look at.
//
// The lines are deliberately NOT pruned from storage: a product hidden for a day
// would otherwise be deleted from someone's cart for good.
async function badgeMatchesDrawer(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;

  const cases = [
    ['only real lines', [{ id: 'p1', qty: 1 }, { id: 'p2', qty: 2 }], 3, 2],
    ['one delisted line', [{ id: 'gone', qty: 1 }, { id: 'p1', qty: 1 }], 1, 1],
    ['every line delisted', [{ id: 'gone', qty: 2 }, { id: 'gone2', qty: 1 }], 0, 0],
    ['quantities add up', [{ id: 'p1', qty: 3 }], 3, 1],
  ];

  for (const [label, cart, wantBadge, wantRows] of cases) {
    const p = await b.newPage();
    await p.setViewportSize({ width: 390, height: 900 });
    await p.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await p.route('**/api/products', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRODUCTS) }));
    await p.route('**/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
    await p.addInitScript((c) => localStorage.setItem('ap_cart', JSON.stringify(c)), cart);
    await p.goto(BASE + '/index.html#cart', { waitUntil: 'load' });
    await p.waitForSelector('.product-card', { timeout: 15000 });
    await p.waitForTimeout(500);

    const m = await p.evaluate(() => {
      const bd = document.getElementById('cartBadge');
      return { badge: bd?.hidden ? 0 : Number(bd?.textContent),
               rows: document.querySelectorAll('#cartBody .cart-item').length };
    });
    ok(`[${name}] badge counts ${label}`, m.badge === wantBadge,
       `badge ${m.badge}, wanted ${wantBadge}`);
    ok(`[${name}] and the drawer shows ${label}`, m.rows === wantRows,
       `${m.rows} rows, wanted ${wantRows}`);
    // The invariant behind both: they must never disagree.
    ok(`[${name}] neither promises more than the other (${label})`,
       (m.badge === 0) === (m.rows === 0) && m.badge >= m.rows,
       JSON.stringify(m));
    await p.close();
  }
  await b.close();
}

// ── touch targets and field sizes, site-wide ──────────────────────────────
//
// Found by measuring rather than by report. Every one was under the threshold it
// is now checked against:
//
//   filter chips     30px tall — how the catalogue is navigated, five side by side
//   "Copy code"      24px tall — beside a ✕ that was already correctly 44
//   modal close ✕    31x28     — the control people reach for to get OUT
//   shop search      14.72px   — the search over 82 products
//   "text to print"  13.6px    — in the cart
//   quote form       15.2px    — how someone asks for custom work
//   hero stat labels 9.6px     — the only words explaining the numbers above them
//
// Thresholds, not exact values, so a redesign stays free to move things.
async function targetsAndFields(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await page(b, 390);
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForSelector('.filter-btn', { timeout: 15000 });
  // Open the cart, checkout and the quote modal so their fields exist to measure.
  await p.evaluate(() => document.getElementById('cartBtn')?.click());
  await p.waitForTimeout(250);
  await p.evaluate(() => {
    const co = document.getElementById('checkoutModal');
    if (co) co.hidden = false;
    if (window.openQuoteModal) window.openQuoteModal({});
  });
  await p.waitForTimeout(400);

  // THE ONE THAT MATTERS MOST. iOS Safari zooms the viewport on focus for any
  // field under 16px, and the first fix was scoped to .co-field only — so the
  // quote form, the search and the cart's "text to print" all still did it.
  const under = await p.evaluate(() =>
    [...document.querySelectorAll('input, textarea, select')]
      .filter((e) => getComputedStyle(e).display !== 'none' && parseFloat(getComputedStyle(e).fontSize) > 0)
      .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16)
      .map((e) => `${e.id || e.name || e.type} ${parseFloat(getComputedStyle(e).fontSize)}px`));
  ok(`[${name}] no field anywhere triggers iOS focus-zoom`, under.length === 0, under.join(', '));

  // Real controls only. Inline links inside prose are legitimately not 44px, and
  // the skip link is deliberately off-screen until focused — measuring those
  // produced pages of noise on the first sweep.
  const small = await p.evaluate(() => {
    const sels = ['.filter-btn', '.promo-copy', '.promo-close', '.cart-close',
                  '.nav-cart', '#cartBtn', '#accountBtn', '.co-promo-apply'];
    const out = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        // 40, not 44: a 44px min-height can compute to 43.x after border-box
        // rounding, and failing on that would be noise rather than a defect.
        if (r.height < 40 || r.width < 40)
          out.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  ok(`[${name}] every real control meets the touch minimum`, small.length === 0, small.join(', '));

  // Text nobody can read may as well not be there.
  const tiny = await p.evaluate(() => {
    const out = [];
    for (const sel of ['.hero-stats .stat-label', '.hero-printer-badge']) {
      for (const el of document.querySelectorAll(sel)) {
        if (getComputedStyle(el).display === 'none') continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) out.push(`${sel} ${fs}px`);
      }
    }
    return out;
  });
  ok(`[${name}] hero labels are large enough to read`, tiny.length === 0, tiny.join(', '));

  // The chips wrap to a second row, which they already did at 30px — so this
  // guards that the extra height did not push the page sideways instead.
  const scroll = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`[${name}] the homepage still does not scroll sideways`, scroll <= 1, String(scroll));

  await b.close();
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  console.log(`\n${name}`);
  for (const w of PHONES) await promoRow(engine, name, w);
  await desktopUntouched(engine, name);
  await cartHash(engine, name);
  await badgeMatchesDrawer(engine, name);
  await targetsAndFields(engine, name);
}

if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall checkout-mobile checks passed');
process.exit(fail ? 1 : 0);
