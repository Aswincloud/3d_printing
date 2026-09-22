// The dashboard's courier picker.
//
// WHY THIS EXISTS. Until this file the dashboard (shop.html + admin.js) had no
// browser coverage at all — every other browser suite drives index.html. The
// ship form is where a courier is chosen, and that choice now decides whether the
// customer's WhatsApp gets a live Track button (ShipTrack's five carriers) or an
// honest "we can't track this one" (anything typed under Other…).
//
// What is pinned, and why each matters:
//   · the SELECT submits the carrier's display NAME ("Blue Dart"), never an id —
//     the shipped email, My Orders and the chat bot all show the stored text
//     verbatim, and trackingUrlFor() / Invoicer's shopCourier() match on letters,
//     so a name resolves everywhere an id would and READS properly where an id
//     would not;
//   · a stored old-style id ("bluedart", from before the dropdown) pre-selects
//     its carrier, so editing an older order does not silently fall to None;
//   · a stored free-text courier pre-selects Other… with the text shown;
//   · Other… reveals the text box and its trimmed value is what is sent.
//
// Auth and the orders API are stubbed; this runs against the static files.

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

const ORDER = (o) => ({
  id: 'o-' + o.key, receipt: 'AP-' + o.key.toUpperCase(), status: o.status, status_label: o.status,
  total_paise: 44800, subtotal_paise: 34900, shipping_paise: 9900, discount_paise: 0,
  cust_name: 'Buyer', cust_email: 'b@example.com', cust_phone: '9000090000',
  addr_line: '1 St', addr_city: 'Pondicherry', addr_state: 'PY', addr_pin: '605001',
  created_at: Date.now() - 86400000, paid_at: Date.now() - 86000000,
  items: [{ name: 'Dragon', qty: 1, price_paise: 34900 }],
  next_stages: o.next, can_refund: true, courier: o.courier || null, tracking_id: o.tracking || null,
  shipped_at: o.status === 'shipped' ? Date.now() : null,
});
const ORDERS = [
  ORDER({ key: 'ready', status: 'ready', next: ['shipped', 'cancelled'] }),
  ORDER({ key: 'oldid', status: 'shipped', next: ['delivered', 'cancelled'], courier: 'bluedart', tracking: 'BD1' }),
  ORDER({ key: 'dtdc', status: 'shipped', next: ['delivered', 'cancelled'], courier: 'DTDC', tracking: 'D2' }),
];
const CARRIERS = ['Blue Dart', 'Delhivery', 'Shiprocket', 'ST Courier', 'The Professional Couriers'];

async function run(engine, name) {
  const b = await launch(engine, name);
  if (!b) return;
  const p = await b.newPage();
  await p.setViewportSize({ width: 1100, height: 900 });
  const patched = [];
  await p.route('**/api/**', (r) => {
    const u = r.request().url(), m = r.request().method();
    const j = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/auth/me')) return j({ signedIn: true, email: 'owner@example.com', is_admin: true, features: {} });
    if (u.includes('/api/admin/orders') && m === 'PATCH') {
      patched.push(JSON.parse(r.request().postData() || '{}'));
      return j({ ok: true, order: ORDERS[0], emailed: true, whatsapp: 'queued' });
    }
    if (u.includes('/api/admin/orders')) return j({ orders: ORDERS, counts: [] });
    if (u.includes('/api/admin/stats')) return j({ orders: 3, revenue_paise: 0, products: 0, quotes: {} });
    return j({ ok: true, products: [], quotes: [], coupons: [], counts: {}, images: [] });
  });

  const load = async () => {
    await p.goto(BASE + '/shop.html', { waitUntil: 'load' });
    await p.waitForSelector('.order-card .order-actions button', { timeout: 15000 });
  };
  const open = async (receipt, labels) => {
    const hit = await p.evaluate(([r, ls]) => {
      const card = [...document.querySelectorAll('.order-card')].find((c) => c.textContent.includes(r));
      const btn = card && [...card.querySelectorAll('.order-actions button')].find((x) => ls.includes(x.textContent.trim()));
      if (!btn) return card ? [...card.querySelectorAll('button')].map((x) => x.textContent.trim()) : 'no card';
      btn.click(); return true;
    }, [receipt, labels]);
    if (hit !== true) throw new Error(`no ${labels.join('/')} on ${receipt}: ${JSON.stringify(hit)}`);
    await p.waitForSelector('form.ship-form select.ship-select', { timeout: 5000 });
  };
  const read = () => p.evaluate(() => {
    const f = document.querySelector('form.ship-form');
    const sel = f.querySelector('select.ship-select');
    const txt = f.querySelector('input.ship-input:not(.ship-select)');
    return { options: [...sel.options].map((o) => o.textContent), selected: sel.options[sel.selectedIndex].textContent,
             textHidden: txt.hidden, textValue: txt.value, focused: document.activeElement === sel };
  });
  const submit = async () => { await p.click('form.ship-form button[type=submit]'); await p.waitForTimeout(400); };

  await load();
  await open('AP-READY', ['Mark shipped']);
  let s = await read();
  ok(`[${name}] the picker lists None, ShipTrack's five carriers, and Other…`,
     JSON.stringify(s.options) === JSON.stringify(['None', ...CARRIERS, 'Other…']), JSON.stringify(s.options));
  ok(`[${name}] a fresh order starts at None with the text box hidden`, s.selected === 'None' && s.textHidden, JSON.stringify(s));
  ok(`[${name}] focus lands on the select`, s.focused);
  await p.selectOption('form.ship-form select.ship-select', '__other__');
  s = await read();
  ok(`[${name}] Other… reveals the text box`, s.textHidden === false);
  await p.fill('form.ship-form input.ship-input:not(.ship-select)', '  India Post  ');
  await p.fill('form.ship-form input[id^=tracking-]', 'EK1');
  await submit();
  ok(`[${name}] Other… submits the typed courier, trimmed`, patched.at(-1)?.courier === 'India Post', JSON.stringify(patched.at(-1)));

  await load();
  await open('AP-OLDID', ['Edit tracking', 'Add tracking']);
  s = await read();
  ok(`[${name}] a stored old-style id "bluedart" pre-selects Blue Dart`, s.selected === 'Blue Dart' && s.textHidden, JSON.stringify(s));
  await p.selectOption('form.ship-form select.ship-select', 'Delhivery');
  await submit();
  ok(`[${name}] choosing a carrier submits its display NAME, never an id`, patched.at(-1)?.courier === 'Delhivery', JSON.stringify(patched.at(-1)));

  await load();
  await open('AP-DTDC', ['Edit tracking', 'Add tracking']);
  s = await read();
  ok(`[${name}] a stored free-text courier pre-selects Other… with the text shown`,
     s.selected === 'Other…' && !s.textHidden && s.textValue === 'DTDC', JSON.stringify(s));
  await p.selectOption('form.ship-form select.ship-select', '');
  await submit();
  ok(`[${name}] None submits an empty courier`, patched.at(-1)?.courier === '', JSON.stringify(patched.at(-1)));

  await b.close();
}

for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  console.log(`\n${name}`);
  await run(engine, name);
}
if (skipped.size) console.warn(`\n  skipped: ${[...skipped].join(', ')}`);
console.log(fail ? `\n${fail} failed` : '\nall dashboard-courier checks passed');
process.exit(fail ? 1 : 0);
