// The homepage promo banner, and who it is shown to.
//
// WHY THIS EXISTS. The banner advertises PROMO_CODE from /api/products — which is
// shared and edge-cached (`s-maxage=60`), so it CANNOT carry per-customer state:
// a field computed for whoever missed the cache would be served to everyone else
// for the next minute. So "have you already used this code?" rides on /api/me,
// which is per-session and no-store, and the banner hides itself.
//
// That splits one decision across two responses that arrive in EITHER order, and
// this file exists mostly for that race. It also covers the nav offset: the
// banner is in normal flow and the fixed nav's `top` reads --promo-h, so a hidden
// banner must contribute 0 or the header floats with a transparent gap above it.
//
// Cosmetic only — applyCoupon() refuses a second redemption regardless. What is
// being prevented is advertising a discount and then declining it at checkout.

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

const PROMO = {
  code: 'WELCOME10', kind: 'percent', value: 10,
  max_discount_paise: 10000, min_order_paise: 0, once_per_customer: true,
};

// `delayMs` is the whole point: it lets each response win the race in turn.
async function stub(page, { me, promoDelay = 0, meDelay = 0 }) {
  await page.route('**/api/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/products', async (r) => {
    if (promoDelay) await new Promise((res) => setTimeout(res, promoDelay));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ products: [], shipping: { flat_paise: 0, free_threshold_paise: 0 }, promo: PROMO }) });
  });
  await page.route('**/api/me', async (r) => {
    if (meDelay) await new Promise((res) => setTimeout(res, meDelay));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
  });
}

const state = (page) => page.evaluate(() => {
  const bar = document.getElementById('promoBanner');
  return {
    hidden: !bar || bar.hidden,
    text: bar ? (document.getElementById('promoText')?.textContent || '').trim() : '',
    promoH: getComputedStyle(document.documentElement).getPropertyValue('--promo-h').trim(),
  };
});

// The banner is drawn from /api/products and possibly withdrawn by /api/me, so
// "settled" means both have been applied — not merely that the bar exists.
async function settle(page) {
  await page.waitForFunction(() => window.__meSeen === true, null, { timeout: 10000 });
  await page.waitForTimeout(150);
}

async function run(engine, engineName, label, opts, expect) {
  const b = await launch(engine, engineName);
  if (!b) return;
  const page = await b.newPage();
  // A flag the page itself sets, so settle() waits on the real response rather
  // than on a fixed sleep.
  await page.addInitScript(() => {
    const f = window.fetch;
    window.fetch = async (...a) => {
      const res = await f(...a);
      if (String(a[0]).includes('/api/me')) window.__meSeen = true;
      return res;
    };
  });
  await stub(page, opts);
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await settle(page);

  const s = await state(page);
  ok(`[${engineName}] ${label}: banner ${expect.hidden ? 'hidden' : 'shown'}`,
     s.hidden === expect.hidden, JSON.stringify(s));

  if (expect.hidden) {
    // The fixed nav reads this. A hidden banner contributing height leaves a
    // transparent gap with the page showing through beneath the header.
    ok(`[${engineName}] ${label}: nav offset reset to 0`,
       s.promoH === '0px' || s.promoH === '0', s.promoH);
  } else {
    ok(`[${engineName}] ${label}: the code is on screen`, s.text.includes('WELCOME10'), s.text);
    ok(`[${engineName}] ${label}: nav offset is non-zero`,
       s.promoH !== '' && s.promoH !== '0px', s.promoH);
  }
  await b.close();
}

const GUEST = { signedIn: false };
const FRESH = { signedIn: true, email: 'new@example.com', name: 'New', is_admin: false, promo_used: false };
const USED = { signedIn: true, email: 'back@example.com', name: 'Back', is_admin: false, promo_used: true };

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  console.log(`\n${name}`);
  await run(engine, name, 'guest', { me: GUEST }, { hidden: false });
  await run(engine, name, 'signed in, unused', { me: FRESH }, { hidden: false });
  await run(engine, name, 'signed in, already used', { me: USED }, { hidden: true });

  // THE RACE, both ways round. The banner is drawn by one response and withdrawn
  // by the other, and neither order may leave it on screen.
  await run(engine, name, 'already used, session lands FIRST',
            { me: USED, promoDelay: 400 }, { hidden: true });
  await run(engine, name, 'already used, catalogue lands FIRST',
            { me: USED, meDelay: 400 }, { hidden: true });
}

if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall promo-banner checks passed');
process.exit(fail ? 1 : 0);
