// The signed-in cart must be adopted ONCE, not on every page load.
//
// /api/me/cart/merge SUMS quantities by design (two on the phone + one on the
// laptop = three). adoptServerCart() used to post the local cart to it on every
// load and then copy the summed result back to localStorage, so each refresh
// added the cart to itself: 1, 2, 4, 8. Reported by Aswin on 2026-09-26 from his
// own account. Guests never saw it, which is why the guest path is not enough.
//
// Drives the real index.html against a fake account cart that sums on merge and
// replaces on PUT, exactly like src/cart.js, and counts the merges.
//
//   node test/browser/cart-adopt.mjs      (BASE_URL defaults to :4173)
import { chromium, webkit } from 'playwright';
import { offline } from './_offline.mjs';
import { renderProductPage } from '../../src/pdp.js';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const REQUIRE_ALL = process.env.CI === 'true';
async function launch(engine, name) {
  try { return await engine.launch(); }
  catch (e) {
    const msg = String(e.message).split('\n')[0];
    if (REQUIRE_ALL) { console.error(`\n  ${name} could not start, and CI requires it: ${msg}`); process.exit(1); }
    console.warn(`  !!   skipping ${name}: ${msg}`); return null;
  }
}

const PRODUCT = { id: 'p1', slug: 'thing', name: 'Thing', price_paise: 10000, image: 'assets/images/x.jpg',
  images: '', category: 'figurine', visible: 1, pinned: 0, compare_at_paise: null, description: 'A thing.' };
const SPIDER = { id: 'p2', slug: 'spiderman', name: 'Spiderman', price_paise: 49900, image: 'assets/images/s.jpg',
  images: '', category: 'figurine', visible: 1, pinned: 0, compare_at_paise: null, description: 'Spiderman, crouching.' };
// The product page is rendered by the Worker, which the static server does not
// run; the real template is rendered here and served for /p/spiderman, with the
// real /assets/js/product.js loading from the static server.
const PDP_HTML = renderProductPage(
  { APP_NAME: 'AswinPrints', APP_BASE_URL: 'http://localhost:4173', FLAT_SHIP_PAISE: '9900', FREE_SHIP_THRESHOLD_PAISE: '200000' },
  { product: SPIDER, related: [], headExtra: '<title>Spiderman</title>' });
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// A fake account cart with the server's real semantics: merge SUMS, PUT replaces.
function fakeServer() {
  const s = { items: [], merges: 0, puts: 0, signedIn: true, email: 'buyer@example.com', failMerges: 0, failPuts: 0 };
  s.stub = async (page) => {
    await page.route('**/api/**', (r) => r.fulfill(json({})));                 // catch-all FIRST
    await page.route('**/p/spiderman', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PDP_HTML }));
    await page.route('**/api/products', (r) => r.fulfill(json({ products: [PRODUCT, SPIDER],
      shipping: { flat_paise: 9900, free_threshold_paise: 200000 }, promo: null })));
    await page.route('**/api/me', (r) => r.fulfill(json(s.signedIn
      ? { signedIn: true, email: s.email, name: 'Buyer', is_admin: false } : { signedIn: false })));
    await page.route('**/api/me/cart', (r) => {
      if (r.request().method() === 'PUT') {
        s.puts++;
        if (s.failPuts > 0) { s.failPuts--; return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); }
        s.items = (r.request().postDataJSON().items || []).map((it) => ({ product_id: it.product_id, qty: it.qty, personalisation: it.personalisation || '' }));
      }
      r.fulfill(json({ items: s.items }));
    });
    await page.route('**/api/me/cart/merge', (r) => {
      s.merges++;
      if (s.failMerges > 0) { s.failMerges--; return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); }
      for (const it of r.request().postDataJSON().items || []) {
        const ex = s.items.find((x) => x.product_id === it.product_id);
        if (ex) ex.qty += it.qty; else s.items.push({ product_id: it.product_id, qty: it.qty, personalisation: it.personalisation || '' });
      }
      r.fulfill(json({ items: s.items, merged: 1 }));
    });
  };
  return s;
}

const localCart = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('ap_cart') || '[]'));
const owner = (page) => page.evaluate(() => localStorage.getItem('ap_cart_owner'));
// Wait for loadSession → adoptServerCart to finish: the page is settled once the
// account button reflects the session and no cart request is in flight.
const settle = (page) => page.waitForTimeout(700);

async function run(engine, engineName) {
  const b = await launch(engine, engineName);
  if (!b) return;
  console.log(`\n${engineName}`);
  const page = await b.newPage();
  await offline(page);
  const s = fakeServer(); await s.stub(page);

  // A guest with one Thing in the cart, then the session turns out to be signed in.
  s.signedIn = false;
  await page.goto(BASE + '/index.html', { waitUntil: 'load' }); await settle(page);
  await page.evaluate(() => localStorage.setItem('ap_cart', JSON.stringify([{ id: 'p1', qty: 1, pz: '' }])));
  s.signedIn = true;
  // The first merge attempt fails (network blip, 5xx). Nothing may be stamped as
  // adopted, so the next load tries again — and only then is the cart the account's.
  s.failMerges = 1;
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('a failed merge leaves the cart unstamped', s.merges === 1 && await owner(page) === null && s.items.length === 0, `merges ${s.merges} owner ${await owner(page)}`);
  ok('and the guest cart is kept for the retry', (await localCart(page))[0]?.qty === 1, JSON.stringify(await localCart(page)));
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('the retry adopts the guest cart with ONE successful merge', s.merges === 2, `merges ${s.merges}`);
  s.merges = 1; // count successful merges from here on
  ok('the account now holds qty 1', s.items.length === 1 && s.items[0].qty === 1, JSON.stringify(s.items));
  ok('the mirror holds qty 1', (await localCart(page))[0]?.qty === 1, JSON.stringify(await localCart(page)));
  ok('the mirror is stamped with its owner', await owner(page) === 'buyer@example.com', String(await owner(page)));

  // THE BUG: refreshing must not merge the mirror into the account again.
  for (let i = 1; i <= 3; i++) { await page.reload({ waitUntil: 'load' }); await settle(page); }
  ok('three refreshes later: still exactly one merge', s.merges === 1, `merges ${s.merges}`);
  ok('account qty still 1 (was doubling to 8)', s.items[0]?.qty === 1, JSON.stringify(s.items));
  ok('mirror qty still 1', (await localCart(page))[0]?.qty === 1, JSON.stringify(await localCart(page)));
  const badge = await page.evaluate(() => document.querySelector('.nav-cart [class*=badge], .cart-badge, [class*=cart-count]')?.textContent.trim());
  ok('the badge says 1', badge === '1', `badge "${badge}"`);

  // A cart edit while signed in goes up as a PUT (replace), never a merge.
  await page.evaluate(() => document.querySelector('.product-card .product-add')?.click()); await settle(page);
  ok('adding one more PUTs the whole cart', s.puts >= 1 && s.items[0]?.qty === 2 && s.merges === 1, `puts ${s.puts} merges ${s.merges} ${JSON.stringify(s.items)}`);

  // The session expires (or a sign-out elsewhere): the mirror belongs to an account
  // that is no longer here, so it is dropped rather than left to be re-merged later.
  s.signedIn = false;
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('signed out: the account mirror is dropped', (await localCart(page)).length === 0, JSON.stringify(await localCart(page)));
  ok('and the owner stamp is cleared', await owner(page) === null, String(await owner(page)));
  ok('the account cart itself is untouched (it lives on the server)', s.items[0]?.qty === 2);

  // A fresh guest cart on the same browser, then sign-in again: merged exactly once.
  await page.evaluate(() => localStorage.setItem('ap_cart', JSON.stringify([{ id: 'p1', qty: 1, pz: '' }])));
  s.signedIn = true;
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('re-sign-in merges the new guest cart once more', s.merges === 2, `merges ${s.merges}`);
  ok('2 on the account + 1 as a guest = 3, the intended sum', s.items[0]?.qty === 3, JSON.stringify(s.items));
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('and a refresh after that changes nothing', s.merges === 2 && s.items[0]?.qty === 3, `merges ${s.merges} ${JSON.stringify(s.items)}`);

  // ── an edit the account never received is pushed UP, not thrown away ──
  // As if main.js's PUT had failed: the mirror says 5 and is flagged dirty, the
  // account still says 3. The next load must send 5 up, not pull 3 down.
  const dirty = () => page.evaluate(() => localStorage.getItem('ap_cart_dirty'));
  await page.evaluate(() => { localStorage.setItem('ap_cart', JSON.stringify([{ id: 'p1', qty: 5, pz: '' }])); localStorage.setItem('ap_cart_dirty', '1'); });
  const putsBefore = s.puts;
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('a dirty mirror is pushed to the account', s.puts === putsBefore + 1 && s.items[0]?.qty === 5, `puts ${s.puts} ${JSON.stringify(s.items)}`);
  ok('and is clean afterwards', await dirty() === null);
  ok('with no merge involved', s.merges === 2, `merges ${s.merges}`);

  // ── the product page: an add there must reach the account ──
  // The bug as reported: one item in the cart, Spiderman added on its product
  // page, badge says 2, click the cart → the homepage showed only the first.
  await page.goto(BASE + '/p/spiderman', { waitUntil: 'load' }); await settle(page);
  await page.click('#pdpAdd'); await settle(page);
  ok('the product page PUTs the whole cart to the account',
     s.items.map((i) => `${i.product_id}:${i.qty}`).sort().join() === 'p1:5,p2:1', JSON.stringify(s.items));
  ok('and marks the mirror clean once it lands', await dirty() === null);
  ok('the badge on the product page counts both', (await page.textContent('#pdpCartBadge')).trim() === '6');
  await page.click('#pdpCartLink'); await page.waitForURL(/\/(index\.html)?#cart$/); await settle(page);
  ok('back on the homepage both items are in the cart',
     (await localCart(page)).map((i) => `${i.id}:${i.qty}`).sort().join() === 'p1:5,p2:1', JSON.stringify(await localCart(page)));

  // ── and when that PUT fails, the homepage pushes it up rather than losing it ──
  s.failPuts = 1;
  await page.goto(BASE + '/p/spiderman', { waitUntil: 'load' }); await settle(page);
  await page.click('#pdpAdd'); await settle(page);
  ok('a failed PUT leaves the mirror dirty', await dirty() === '1');
  ok('and the account still has the old cart', s.items.find((i) => i.product_id === 'p2')?.qty === 1, JSON.stringify(s.items));
  await page.goto(BASE + '/index.html', { waitUntil: 'load' }); await settle(page);
  ok('the homepage then pushes the local cart up: Spiderman ×2 on the account', s.items.find((i) => i.product_id === 'p2')?.qty === 2, JSON.stringify(s.items));
  ok('and shows it', (await localCart(page)).find((i) => i.id === 'p2')?.qty === 2);
  ok('mirror clean again', await dirty() === null);

  // ── the same safety net for the homepage's own edits ──
  // A cart edit here PUTs immediately; if that PUT fails the flag must stay so the
  // next load pushes it, instead of the account's older copy replacing the edit.
  s.failPuts = 1;
  await page.evaluate(() => document.querySelector('.product-card .product-add')?.click()); await settle(page);
  ok('a failed PUT from the homepage leaves the mirror dirty', await dirty() === '1');
  const thingBefore = s.items.find((i) => i.product_id === 'p1')?.qty;
  await page.reload({ waitUntil: 'load' }); await settle(page);
  ok('the next load pushes the edit up', s.items.find((i) => i.product_id === 'p1')?.qty === thingBefore + 1, `${thingBefore} → ${JSON.stringify(s.items)}`);
  ok('and the mirror is clean', await dirty() === null);

  await b.close();
}

await run(chromium, 'chromium');
await run(webkit, 'webkit');
console.log(`\n  cart-adopt: ${fail ? fail + ' failed' : 'all passed'}`);
process.exit(fail ? 1 : 0);
