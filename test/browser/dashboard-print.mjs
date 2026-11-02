// The dashboard's "Download .3mf for Bambu Studio" button on a custom keychain
// order line. The file is built IN THE BROWSER (public/assets/js/kc-build.js):
// the Worker is on the free plan and only hands over the inputs. This drives the
// real button against the static site, with the print-job API stubbed by a
// stand-in body (the real one is private), and checks the browser really
// downloads a valid Bambu project — in Chromium and WebKit, since the zip uses
// CompressionStream.
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { offline } from './_offline.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const REQUIRE_ALL = process.env.CI === 'true';
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const BODY = { v: [-60, -16, -2.6, 60, -16, -2.6, 60, 16, -2.6, -60, 16, -2.6, -60, -16, 2.6, 60, -16, 2.6, 60, 16, 2.6, -60, 16, 2.6],
  t: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
const TEMPLATE = { settings: { printer_model: 'Bambu Lab A1', filament_colour: ['#000000'] }, per_filament: ['filament_colour'] };
const JOB = (qty) => ({ receipt: 'AP-KC1', design: { text: 'Aswin', font: 'script', base: 'white', ink: 'pink' }, qty,
  colours: ['#f4f4f2', '#f06fae', '#f4f4f2'], font: '/assets/fonts3d/kc-script.json', initialFont: '/assets/fonts3d/kc-rounded.json',
  bodies: { heart: BODY }, template: TEMPLATE });
const ORDER = (id, qty) => ({
  id, receipt: 'AP-KC1', status: 'paid', status_label: 'paid', total_paise: 29900 * qty, subtotal_paise: 29900 * qty,
  shipping_paise: 0, discount_paise: 0, cust_name: 'Buyer', cust_email: 'b@example.com', cust_phone: '9000090000',
  addr_line: '1 St', addr_city: 'Pondicherry', addr_state: 'PY', addr_pin: '605001', created_at: Date.now(), paid_at: Date.now(),
  items: [
    { name: 'Custom Name Keychain', qty, price_paise: 29900, personalisation: '"Aswin" · Script font · White base, Pink text', pos: 0, has_print: 1 },
    { name: 'Dragon', qty: 1, price_paise: 34900, pos: 1, has_print: 0 },
  ],
  next_stages: ['in_production', 'cancelled'], can_refund: true,
});

function unzipNames(buf) {
  const b = Buffer.from(buf), names = {};
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    const csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    const l = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    names[name] = inflateRawSync(b.subarray(l, l + csize)).toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return names;
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  let b;
  try { b = await engine.launch(); } catch (e) {
    if (REQUIRE_ALL) { console.error(`${name} could not start, and CI requires it`); process.exit(1); }
    console.warn(`  !! ${name} did not run`); continue;
  }
  console.log(`\n${name}`);
  for (const qty of [2, 30]) {
    const ctx = await b.newContext({ acceptDownloads: true });
    const p = await ctx.newPage();
    await offline(p);
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const jobs = [];
    await p.route('**/api/**', (r) => {
      const u = r.request().url();
      const j = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.includes('/api/auth/me')) return j({ signedIn: true, email: 'owner@example.com', is_admin: true, features: {} });
      if (/\/api\/admin\/orders\/[^/]+\/print\/0$/.test(u)) { jobs.push(u); return j(JOB(qty)); }
      if (u.includes('/api/admin/orders')) return j({ orders: [ORDER('11111111-1111-4111-8111-111111111111', qty)], counts: [] });
      if (u.includes('/api/admin/stats')) return j({ orders: 1, revenue_paise: 0, products: 0, quotes: {} });
      return j({ ok: true, products: [], quotes: [], coupons: [], counts: {}, images: [], reviews: [], events: [] });
    });
    await p.addInitScript(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); });
    await p.goto(BASE + '/shop.html', { waitUntil: 'load' });
    await p.waitForSelector('.order-card', { timeout: 15000 });
    const buttons = await p.$$eval('.order-card .oi-print', (bs) => bs.map((x) => x.textContent));
    ok(`[${name} qty ${qty}] one button, on the keychain line only`, buttons.length === 1, JSON.stringify(buttons));
    const want = qty > 24 ? 2 : 1;
    const got = [];
    p.on('download', (d) => got.push(d));
    await p.click('.oi-print');
    for (let i = 0; i < 150 && got.length < want; i++) await p.waitForTimeout(100);
    ok(`[${name} qty ${qty}] the job is fetched from the owner route`, jobs.length === 1 && jobs[0].includes('/api/admin/orders/11111111-1111-4111-8111-111111111111/print/0'));
    const names = got.map((d) => d.suggestedFilename());
    ok(`[${name} qty ${qty}] ${want} file(s) downloaded with the right names`,
      JSON.stringify(names) === JSON.stringify(qty > 24 ? ['AP-KC1-Aswin-white-pink-x24-part1of2.3mf', 'AP-KC1-Aswin-white-pink-x6-part2of2.3mf'] : ['AP-KC1-Aswin-white-pink-x2.3mf']), JSON.stringify(names));
    if (got[0]) {
      const z = unzipNames(readFileSync(await got[0].path()));
      ok(`[${name} qty ${qty}] the download is a Bambu project in the customer's colours`,
        JSON.parse(z['Metadata/project_settings.config'] || '{}').filament_colour?.join() === '#F4F4F2,#F06FAE'
        && (z['3D/3dmodel.model'].match(/<item /g) || []).length === Math.min(qty, 24), Object.keys(z).join(','));
    }
    // Only errors from the print path count: other dashboard tabs read stubbed
    // endpoints this test does not fill in.
    const mine = errs.filter((m) => /kc-|polygon|earcut|zip|print|Blob|deflate|Compression/i.test(m));
    const alerts = await p.evaluate(() => window.__alerts || []);
    ok(`[${name} qty ${qty}] no errors building the file`, mine.length === 0 && alerts.length === 0, [...mine, ...alerts].join(' | '));
    await ctx.close();
  }
  await b.close();
}
console.log(fail ? `\n${fail} failed` : '\nall dashboard-print checks passed');
process.exit(fail ? 1 : 0);
