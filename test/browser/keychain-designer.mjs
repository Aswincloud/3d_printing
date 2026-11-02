// The custom name keychain designer (/keychain): the 3D preview renders, the
// controls change the design and the price (one colour ₹199, two colours ₹299),
// bad text is blocked, and Add to cart stores the design as its own cart line in
// the exact id format the server parses (src/keychain.js).
//
// The page is server-rendered (src/keychainpage.js); a static server cannot run
// it, so this renders the page's HTML the same way and serves it at /keychain.
import { chromium, webkit } from 'playwright';
import { keychainPage } from '../../src/keychainpage.js';
import { designId, parseDesign } from '../../src/keychain.js';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const REQUIRE_ALL = process.env.CI === 'true';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ name: 'Custom Name Keychain' }) }) }) } };
const html = await (await keychainPage(env)).text();

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  let b;
  try { b = await engine.launch(name === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}); }
  catch { if (REQUIRE_ALL) { console.error(`${name} could not start, and CI requires it`); process.exit(1); } console.warn(`  !! ${name} did not run`); continue; }
  console.log(`\n${name}`);
  for (const [w, h] of [[1280, 860], [390, 844]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/keychain', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await p.route('**/assets/js/activity.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await p.goto(BASE + '/keychain', { waitUntil: 'load' });
    await p.waitForTimeout(2500);
    const tag = `[${name} ${w}]`;
    ok(`${tag} the 3D preview renders`, await p.evaluate(() => { const c = document.querySelector('#kcCanvas canvas'); return Boolean(c && c.width > 100 && c.height > 100); }));
    ok(`${tag} starts at ₹199, one colour`, (await p.textContent('#kcPrice')) === '₹199');
    await p.fill('#kcText', 'PRIYA'); await p.click('[data-font="classic"]');
    await p.click('#kcBase .kc-swatch[aria-label="Blue"]'); await p.check('#kcTwoTone');
    await p.click('#kcInk .kc-swatch[aria-label="Gold"]'); await p.waitForTimeout(500);
    ok(`${tag} two colours → ₹299`, (await p.textContent('#kcPrice')) === '₹299');
    ok(`${tag} the summary reads the design`, (await p.textContent('#kcSummary')) === '"PRIYA" · Classic font · Blue base, Gold text', await p.textContent('#kcSummary'));
    // Keyboard: pick a colour with Enter; focus must stay on that swatch.
    await p.focus('#kcBase .kc-swatch[aria-label="Green"]'); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
    ok(`${tag} a keyboard colour pick keeps focus on the swatch`, await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Green' && document.activeElement.getAttribute('aria-pressed') === 'true'));
    await p.click('#kcBase .kc-swatch[aria-label="Blue"]'); await p.waitForTimeout(150);
    await p.click('#kcAdd'); await p.waitForTimeout(200);
    const cart = await p.evaluate(() => JSON.parse(localStorage.getItem('ap_cart') || '[]'));
    const want = designId({ text: 'PRIYA', font: 'classic', base: 'blue', ink: 'gold' });
    ok(`${tag} Add to cart stores the server's id for this design`, cart.length === 1 && cart[0].id === want && parseDesign(cart[0].id)?.ink === 'gold', JSON.stringify(cart));
    // Buy now hands off THIS keychain only (not the cart) to checkout.
    await p.route('**/index.html', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>shop</title>' }));
    await p.evaluate(() => sessionStorage.removeItem('ap_buynow'));
    await p.click('#kcBuy'); await p.waitForTimeout(400);
    const handoff = await p.evaluate(() => sessionStorage.getItem('ap_buynow'));
    ok(`${tag} Buy now hands off just this design`, handoff === JSON.stringify([{ id: want, qty: 1 }]), handoff);
    await p.goto(BASE + '/keychain', { waitUntil: 'load' }); await p.waitForTimeout(1500);
    await p.fill('#kcText', '<b>hi</b>'); await p.waitForTimeout(150);
    ok(`${tag} bad text blocks Add to cart`, !(await p.isEnabled('#kcAdd')) && /only/.test(await p.textContent('#kcError')));
    await p.fill('#kcText', 'ABCDEFGHIJKLM'); await p.waitForTimeout(150);
    ok(`${tag} 13 characters blocks Add to cart`, !(await p.isEnabled('#kcAdd')));
    ok(`${tag} no page errors`, errs.length === 0, errs.join(' | '));
    ok(`${tag} no sideways scroll`, !(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await p.close();
  }
  await b.close();
}
// The base keychain product on the shop grid sends people to the designer
// rather than adding a blank keychain (addToCart in main.js).
{
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await p.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"signedIn":false}' }));
  await p.route('**/api/products', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    products: [{ id: 'kc1', slug: 'custom-name-keychain', name: 'Custom Name Keychain', price_paise: 19900, image: 'assets/images/plate_keychains.jpg', images: [], category: 'functional', visible: 1 }],
    shipping: { flat_paise: 0, free_threshold_paise: 200000 }, sales: [] }) }));
  await p.route('**/keychain', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>designer</title>' }));
  await p.goto(BASE + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(1200);
  const went = await p.evaluate(() => { addToCart('kc1'); return null; }).then(() => p.waitForURL(/\/keychain$/, { timeout: 4000 }).then(() => true, () => false));
  const cart = await p.evaluate(() => localStorage.getItem('ap_cart'));
  ok('[chromium] the base keychain card goes to the designer, adds nothing', went && (!cart || cart === '[]'), `went=${went} cart=${cart}`);
  await b.close();
}
console.log(fail ? `\n${fail} failed` : '\nall keychain-designer checks passed');
process.exit(fail ? 1 : 0);
