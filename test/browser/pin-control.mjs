// The admin pin control, and the catalogue ordering it drives.
//
// WHY THIS EXISTS. Pinning is the one piece of admin UI that lives on the PUBLIC
// page, so two things have to be true at once: a customer must see a plain
// "Featured" badge and no controls, and an admin must see that same badge turned
// into a toggle. Neither is checkable from the server tests — src/shop.js decides
// the order, but which element is drawn, and where it lands on the photo, is
// decided in main.js and style.css.
//
// It also guards a bug this check found before release. The first version
// re-ordered the `catalogue` array in place on every pin. Pinning looked right;
// UNPINNING left the card stranded near the top, because a cumulative sort has no
// memory of where the row belonged. It corrected itself on reload, which is
// exactly the shape of bug that reads to Aswin as "the unpin didn't work".
// renderProducts() now derives the view from the pristine server order instead,
// and "unpinning restores the original order" below is what holds it there.
//
// Runs against the static files with /api/* stubbed: this is DOM and CSS, so it
// needs no D1, no secrets and no wrangler. The server side — who is allowed to
// write `pinned`, and what SQL orders the rows — is covered in test/admin.mjs and
// test/shop.mjs, the latter against real SQLite.

import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Same policy as hero-geometry.mjs: an engine that quietly fails to start is a
// check that is not running, which is tolerable on a dev box and not in CI.
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
    if (!skipped.has(name)) {
      skipped.add(name);
      console.warn(`  !!   skipping ${name}: ${msg}`);
    }
    return null;
  }
}

// A fixture shaped like the real payload. `pinned-one` leads because the SERVER
// sorts pinned first — the page must not have to work that out for itself on
// first paint. The synthesised card (id: null) is the one that can never be
// pinned, because there is no row behind it.
const product = (id, name, extra = {}) => ({
  id, slug: id, name, description: '', price_paise: 34900, quote_only: false,
  image: 'assets/images/placeholder.jpg', images: [], category: 'figurine',
  personalise_label: '', personalise_required: false, pinned: false, ...extra,
});

const PAYLOAD = {
  products: [
    product('pinned-one', 'Already Pinned', { pinned: true }),
    product('a', 'Alpha'),
    product('b', 'Bravo'),
    product('c', 'Charlie'),
    product('d', 'Delta'),
    product('e', 'Echo'),
    { ...product(null, 'Synthesised Photo'), slug: null, price_paise: 0, quote_only: true },
  ],
  shipping: { flat_paise: 9900, free_threshold_paise: 200000 },
  promo: null,
};

async function stub(page, { admin }) {
  // ORDER MATTERS. Playwright matches routes in REVERSE registration order, so the
  // catch-all has to be registered FIRST or it wins over every specific route below
  // it — which it did, and the grid rendered "Nothing listed just yet".
  //
  // It exists so that any other /api/ call the page makes is answered rather than
  // left hanging, and a waitForSelector never ends up waiting on a dead request.
  await page.route('**/api/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));

  await page.route('**/api/products', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD),
  }));
  await page.route('**/api/me', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(admin
      ? { signedIn: true, email: 'owner@example.com', name: 'Owner', is_admin: true }
      : { signedIn: false }),
  }));
  const patched = [];
  await page.route('**/api/admin/products/*', (r) => {
    patched.push({ method: r.request().method(), body: r.request().postDataJSON(),
                   url: r.request().url() });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return patched;
}

const names = (page) =>
  page.$$eval('.product-card .product-name', (els) => els.map((e) => e.textContent.trim()));

async function customerView(engine, engineName) {
  const b = await launch(engine, engineName);
  if (!b) return;
  const page = await b.newPage();
  await stub(page, { admin: false });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForSelector('.product-card', { timeout: 15000 });

  const badges = await page.$$eval('.product-featured',
    (els) => els.map((e) => ({ tag: e.tagName, text: e.textContent.trim() })));
  ok(`[${engineName}] one Featured badge, for the one pinned product`,
     badges.length === 1, JSON.stringify(badges));
  ok(`[${engineName}] it is a span, not a control`, badges[0]?.tag === 'SPAN', badges[0]?.tag);
  ok(`[${engineName}] a customer gets no pin buttons at all`,
     (await page.$$('button.product-featured')).length === 0);
  ok(`[${engineName}] the pinned product leads on first paint`,
     (await names(page))[0] === 'Already Pinned');

  // Geometry: the badge has to be visible ON the photo and must not land on the
  // share button, which owns the opposite corner.
  const geo = await page.$eval('.product-featured', (e) => {
    const r = e.getBoundingClientRect();
    const m = e.closest('.product-media').getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, top: r.top - m.top, left: r.left - m.left,
             right: r.right, opacity: Number(cs.opacity), z: cs.zIndex };
  });
  ok(`[${engineName}] badge is rendered with real size`, geo.w > 20 && geo.h > 10, JSON.stringify(geo));
  ok(`[${engineName}] badge sits top-left of the photo`,
     geo.top >= 0 && geo.top < 24 && geo.left >= 0 && geo.left < 24, JSON.stringify(geo));
  ok(`[${engineName}] badge is fully opaque`, geo.opacity === 1, String(geo.opacity));

  const share = await page.$eval('.product-card:first-child .product-share',
    (e) => e.getBoundingClientRect().left).catch(() => null);
  ok(`[${engineName}] badge does not overlap the share button`,
     share === null || geo.right <= share, JSON.stringify({ badgeRight: geo.right, shareLeft: share }));

  await b.close();
}

async function adminView(engine, engineName) {
  const b = await launch(engine, engineName);
  if (!b) return;
  const page = await b.newPage();
  const patched = await stub(page, { admin: true });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });

  // The grid renders before /api/me resolves, so the buttons arriving at all is
  // the assertion — it is the re-render in applySignedInState() that puts them there.
  await page.waitForSelector('button.product-featured', { timeout: 15000 });

  const btns = await page.$$eval('button.product-featured', (els) => els.map((e) => ({
    text: e.textContent.trim(), ghost: e.classList.contains('ghost'),
    pressed: e.getAttribute('aria-pressed'),
  })));
  const cards = (await names(page)).length;
  ok(`[${engineName}] pin buttons appear once the session resolves`, btns.length > 0);
  ok(`[${engineName}] one reads Featured, the rest read Pin`,
     btns.filter((x) => x.text === 'Featured').length === 1 &&
     btns.filter((x) => x.text === 'Pin').length === btns.length - 1,
     JSON.stringify(btns.map((x) => x.text)));
  ok(`[${engineName}] the pinned one is solid, the others ghosted`,
     btns.find((x) => x.text === 'Featured')?.ghost === false &&
     btns.filter((x) => x.text === 'Pin').every((x) => x.ghost));
  ok(`[${engineName}] aria-pressed tracks the state`,
     btns.find((x) => x.text === 'Featured')?.pressed === 'true' &&
     btns.filter((x) => x.text === 'Pin').every((x) => x.pressed === 'false'));
  // One card is synthesised and has no row to pin.
  ok(`[${engineName}] the synthesised card gets no button`,
     btns.length === cards - 1, `${btns.length} buttons / ${cards} cards`);

  const clickPin = (want) => page.$$eval('.product-card', (cs, n) => {
    cs.find((c) => c.querySelector('.product-name')?.textContent.trim() === n)
      .querySelector('button.product-featured').click();
  }, want);

  const before = await names(page);
  const target = before[4];                     // well down the grid, so it has to travel

  await clickPin(target);
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.product-card')]
      .find((c) => c.querySelector('.product-name')?.textContent.trim() === n)
      ?.querySelector('button.product-featured')?.textContent.trim() === 'Featured',
    target, { timeout: 5000 });

  ok(`[${engineName}] a PATCH went out`, patched.length === 1, JSON.stringify(patched));
  ok(`[${engineName}] it PATCHes pinned:true`,
     patched[0]?.method === 'PATCH' && patched[0]?.body?.pinned === true,
     JSON.stringify(patched[0]));
  // Not just "a PATCH happened" — it must address the card that was clicked.
  const wantId = PAYLOAD.products.find((x) => x.name === target).id;
  ok(`[${engineName}] it PATCHes the clicked product's own id`,
     patched[0]?.url.endsWith('/api/admin/products/' + wantId),
     `${patched[0]?.url} (expected id ${wantId})`);

  // The photo is itself a click target. Without stopPropagation, pinning would
  // also throw the lightbox open over the grid.
  ok(`[${engineName}] the lightbox did not open`,
     !(await page.$eval('#lightbox', (e) => e.classList.contains('active'))));

  const after = await names(page);
  ok(`[${engineName}] the pinned card joins the pinned block`,
     after.indexOf(target) === 1, `was #${before.indexOf(target)}, now #${after.indexOf(target)}`);
  ok(`[${engineName}] the already-pinned card still leads`, after[0] === before[0], after[0]);
  ok(`[${engineName}] every other card keeps its relative order`,
     JSON.stringify(after.filter((n) => n !== target)) ===
     JSON.stringify(before.filter((n) => n !== target)));

  // THE REGRESSION GUARD. See the header.
  await clickPin(target);
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.product-card')]
      .find((c) => c.querySelector('.product-name')?.textContent.trim() === n)
      ?.querySelector('button.product-featured')?.textContent.trim() === 'Pin',
    target, { timeout: 5000 });

  ok(`[${engineName}] unpin PATCHes pinned:false`, patched[1]?.body?.pinned === false,
     JSON.stringify(patched[1]?.body));
  ok(`[${engineName}] unpinning puts the card back where it came from`,
     JSON.stringify(await names(page)) === JSON.stringify(before),
     JSON.stringify(await names(page)));

  await b.close();
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  console.log(`\n${name} — customer`);
  await customerView(engine, name);
  console.log(`${name} — admin`);
  await adminView(engine, name);
}

if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall pin-control checks passed');
process.exit(fail ? 1 : 0);
