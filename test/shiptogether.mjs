// Ship together: several orders from one customer, one parcel, one email, one
// WhatsApp. Real SQLite with every migration applied; Resend and the invoicer
// are stubbed at the fetch boundary.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { shipTogether, listOrders } from "../src/admin.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql), async batch(st) { for (const s of st) await s.run(); } };
}
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  const calls = { mail: [], invoicer: [] };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === "api.resend.com") { calls.mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}'); }
    if (u.hostname === "invoicer.test") { calls.invoicer.push({ path: u.pathname, body: JSON.parse(init.body), sig: init.headers["x-shop-signature"], redirect: init.redirect });
      return new Response('{"ok":true,"whatsapp":"sent"}'); }
    throw new Error("unexpected fetch " + url);
  };
  const env = { DB: d1(db), RESEND_API_KEY: "k", OWNER_EMAIL: "owner@example.com", APP_BASE_URL: "https://shop.test",
    INVOICE_ENABLED: "true", INVOICER_URL: "https://invoicer.test", SHOP_INGEST_SECRET: "s" };
  return { db, env, calls };
}
let seq = 0;
function order(db, id, o = {}) {
  const r = { status: "paid", email: "hitesh@example.com", phone: "+91 98765 47837", name: "Hitesh", addr: "Flat 4, MG Road", item: "Item " + id, ...o };
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery,
      cust_name, cust_email, cust_phone, addr_line, addr_city, addr_state, addr_pin, created_at, pay_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "AP-" + id, "r" + id, r.status, 59900, 0, 59900, "INR", "ship",
      r.name, r.email, r.phone, r.addr, "Pune", "Maharashtra", "411001", ++seq, (id + "0".repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, "a"));
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, pos) VALUES (?,?,?,?,?,?,?)`).run("i" + id, id, null, r.item, 59900, 1, 0);
}
const ship = async (env, body) => { const r = await shipTogether(env, body); return [r.status, await r.json()]; };
const status = (db, id) => db.prepare("SELECT status, courier, tracking_id, shipped_at FROM orders WHERE id = ?").get(id);

section("three orders, one parcel");
{
  const { db, env, calls } = setup();
  order(db, "d815a79e", { item: "Shiva Lingam", addr: "Short St" });
  order(db, "d47ad3de", { item: "Seven Horses", email: "HITESH@example.com", addr: "Flat 4, MG Road, near the long landmark" });
  order(db, "a9fb0429", { item: "Balaji Idol", status: "in_production", phone: "09876547837" });
  const [st, out] = await ship(env, { ids: ["d815a79e", "d47ad3de", "a9fb0429"], ship_to: "d47ad3de", courier: "The Professional Couriers", tracking_id: "PON7004549" });
  ok("200, all three shipped", st === 200 && out.shipped.length === 3, JSON.stringify(out));
  ok("the chosen address's order leads", out.shipped[0] === "AP-d47ad3de", out.shipped.join(","));
  for (const id of ["d815a79e", "d47ad3de", "a9fb0429"]) {
    const s = status(db, id);
    ok(`${id}: shipped with the shared tracking`, s.status === "shipped" && s.tracking_id === "PON7004549" && s.courier === "The Professional Couriers" && s.shipped_at > 0, JSON.stringify(s));
  }
  ok("ONE email", calls.mail.length === 1, String(calls.mail.length));
  const m = calls.mail[0];
  ok("to the customer (the address order's email), owner copied", JSON.stringify(m.to).toLowerCase() === '["hitesh@example.com"]' && JSON.stringify(m.bcc) === '["owner@example.com"]', JSON.stringify([m.to, m.bcc]));
  ok("lists every order and item", ["AP-d815a79e", "AP-d47ad3de", "AP-a9fb0429", "Shiva Lingam", "Seven Horses", "Balaji Idol"].every((x) => m.html.includes(x)));
  ok("shows the CHOSEN address only", m.html.includes("near the long landmark") && !m.html.includes("Short St"));
  ok("shows the tracking number and a courier link", m.html.includes("PON7004549") && m.html.includes("shiptrack.aswincloud.com/track/tpc/PON7004549"));
  ok("subject says how many", /Your 3 orders have shipped/.test(m.subject), m.subject);
  ok("ONE signed call to the invoicer", calls.invoicer.length === 1 && calls.invoicer[0].path === "/api/ingest/shipment-combined" && /^[0-9a-f]{64}$/.test(calls.invoicer[0].sig), JSON.stringify(calls.invoicer.map((c) => c.path)));
  ok("…with all receipts, lead first", JSON.stringify(calls.invoicer[0].body.receipts) === '["AP-d47ad3de","AP-d815a79e","AP-a9fb0429"]', JSON.stringify(calls.invoicer[0].body.receipts));
  ok("…refusing redirects", calls.invoicer[0].redirect === "manual");

  const [st2, again] = await ship(env, { ids: ["d815a79e", "d47ad3de"], ship_to: "d815a79e", courier: "x", tracking_id: "T2" });
  ok("a second click: refused, nothing sent", st2 === 409 && calls.mail.length === 1 && calls.invoicer.length === 1, JSON.stringify(again));
}

section("what is refused");
{
  const { db, env, calls } = setup();
  order(db, "aaaa0001");
  order(db, "aaaa0002");
  order(db, "bbbb0001", { email: "stranger@example.com", phone: "9000000000", name: "Stranger" });
  order(db, "cccc0001", { status: "shipped" });
  order(db, "dddd0001", { status: "pending" });
  const cases = [
    ["one order", { ids: ["aaaa0001"], ship_to: "aaaa0001", tracking_id: "T" }, 400],
    ["no tracking number", { ids: ["aaaa0001", "aaaa0002"], ship_to: "aaaa0001", tracking_id: "" }, 400],
    ["ship_to not among them", { ids: ["aaaa0001", "aaaa0002"], ship_to: "bbbb0001", tracking_id: "T" }, 400],
    ["a stranger's order mixed in", { ids: ["aaaa0001", "bbbb0001"], ship_to: "aaaa0001", tracking_id: "T" }, 409],
    ["an already shipped order", { ids: ["aaaa0001", "cccc0001"], ship_to: "aaaa0001", tracking_id: "T" }, 409],
    ["an unpaid order", { ids: ["aaaa0001", "dddd0001"], ship_to: "aaaa0001", tracking_id: "T" }, 409],
    ["an unknown id", { ids: ["aaaa0001", "nope"], ship_to: "aaaa0001", tracking_id: "T" }, 404],
    ["eleven orders", { ids: Array.from({ length: 11 }, (_, i) => "x" + i), ship_to: "x0", tracking_id: "T" }, 400],
    ["duplicates collapse to one", { ids: ["aaaa0001", "aaaa0001"], ship_to: "aaaa0001", tracking_id: "T" }, 400],
  ];
  for (const [label, body, want] of cases) {
    const [s] = await ship(env, body);
    ok(`${label} → ${want}`, s === want, String(s));
  }
  ok("none of those changed an order or sent anything", ["aaaa0001", "aaaa0002", "bbbb0001"].every((id) => status(db, id).status === "paid") && calls.mail.length === 0 && calls.invoicer.length === 0);
}

section("one identifier must be shared by ALL the orders");
{
  const { db, env, calls } = setup();
  // B is the OLDEST and bridges: A shares B's email, C shares B's phone, A and C
  // share nothing. "Each matches the first" would pass this; one shared
  // identifier for all does not.
  order(db, "kkkk0002", { email: "alice@example.com", phone: "9222222222" });
  order(db, "kkkk0001", { email: "alice@example.com", phone: "9111111111" });
  order(db, "kkkk0003", { email: "carol@example.com", phone: "9222222222", name: "Carol", item: "Carol's private item" });
  const [s] = await ship(env, { ids: ["kkkk0001", "kkkk0002", "kkkk0003"], ship_to: "kkkk0001", tracking_id: "T" });
  ok("a chain (email for one pair, phone for another) is refused", s === 409 && calls.mail.length === 0, String(s));
  const data = await (await listOrders(env, new URL("https://x/api/admin/orders"))).json();
  const g = data.orders.find((o) => o.id === "kkkk0001").ship_together.map((x) => x.id).sort();
  ok("…and the dashboard never groups A with C", JSON.stringify(g) === '["kkkk0001","kkkk0002"]', JSON.stringify(g));
  const gb = data.orders.find((o) => o.id === "kkkk0002").ship_together.map((x) => x.id).sort();
  ok("…not even from the bridging order's card", gb.length === 2 && !(gb.includes("kkkk0001") && gb.includes("kkkk0003")), JSON.stringify(gb));
  const [s2] = await ship(env, { ids: ["kkkk0002", "kkkk0003"], ship_to: "kkkk0002", tracking_id: "T" });
  ok("B and C, sharing a phone, may ship together", s2 === 200, String(s2));
}

section("two strangers with the same junk phone are not one customer");
{
  const { db, env, calls } = setup();
  order(db, "jjjj0001", { email: "a@example.com", phone: "12" });
  order(db, "jjjj0002", { email: "b@example.com", phone: "12", name: "B" });
  const [s] = await ship(env, { ids: ["jjjj0001", "jjjj0002"], ship_to: "jjjj0001", tracking_id: "T" });
  ok("refused (409), nothing sent", s === 409 && calls.mail.length === 0, String(s));
}

section("a race: an order ships between the read and the write");
{
  const { db, env, calls } = setup();
  order(db, "rrrr0001"); order(db, "rrrr0002"); order(db, "rrrr0003");
  // Wrap the DB so that, right after the SELECT, another request ships rrrr0002.
  const real = env.DB;
  env.DB = { ...real, prepare(sql) {
    const st = real.prepare(sql);
    if (/SELECT \* FROM orders WHERE id IN/.test(sql)) {
      return { bind: (...a) => ({ all: async () => { const r = await st.bind(...a).all();
        db.prepare("UPDATE orders SET status = 'shipped', tracking_id = 'OTHER' WHERE id = 'rrrr0002'").run(); return r; } }) };
    }
    return st;
  } };
  const [st, out] = await ship(env, { ids: ["rrrr0001", "rrrr0002", "rrrr0003"], ship_to: "rrrr0001", courier: "Blue Dart", tracking_id: "BD1" });
  ok("only the two that were still waiting are shipped and named", st === 200 && JSON.stringify(out.shipped) === '["AP-rrrr0001","AP-rrrr0003"]', JSON.stringify(out));
  ok("the one shipped elsewhere keeps its own tracking", status(db, "rrrr0002").tracking_id === "OTHER");
  ok("the email lists only those two", !calls.mail[0].html.includes("AP-rrrr0002") && calls.mail[0].html.includes("AP-rrrr0003"));
  ok("the invoicer is told only those two", JSON.stringify(calls.invoicer[0].body.receipts) === '["AP-rrrr0001","AP-rrrr0003"]');
}

section("the chosen address stands even if that order shipped elsewhere");
{
  const { db, env, calls } = setup();
  order(db, "ssss0001", { addr: "Chosen Lane 1" }); order(db, "ssss0002", { addr: "Other Road 2" }); order(db, "ssss0003", { addr: "Third St 3" });
  const real = env.DB;
  env.DB = { ...real, prepare(sql) {
    const st = real.prepare(sql);
    if (/SELECT \* FROM orders WHERE id IN/.test(sql)) {
      return { bind: (...a) => ({ all: async () => { const r = await st.bind(...a).all();
        db.prepare("UPDATE orders SET status = 'shipped' WHERE id = 'ssss0001'").run(); return r; } }) };
    }
    return st;
  } };
  const [st, out] = await ship(env, { ids: ["ssss0001", "ssss0002", "ssss0003"], ship_to: "ssss0001", courier: "Blue Dart", tracking_id: "BD9" });
  ok("only the two that moved are reported", st === 200 && JSON.stringify(out.shipped) === '["AP-ssss0002","AP-ssss0003"]', JSON.stringify(out));
  ok("the email still shows the CHOSEN address", calls.mail[0].html.includes("Chosen Lane 1") && !calls.mail[0].html.includes("Other Road 2"));
  ok("…and does not list the order that shipped elsewhere", !calls.mail[0].html.includes("AP-ssss0001"));
}

section("the dashboard offers it only where it applies");
{
  const { db, env } = setup();
  order(db, "eeee0001"); order(db, "eeee0002", { status: "ready", email: "EEEE@x.com", phone: "98765-47837" });
  order(db, "ffff0001", { email: "solo@example.com", phone: "9111111111" });
  order(db, "eeee0003", { status: "shipped" });
  const data = await (await listOrders(env, new URL("https://x/api/admin/orders"))).json();
  const by = Object.fromEntries(data.orders.map((o) => [o.id, o.ship_together]));
  ok("same customer by phone: offered on both", by.eeee0001.length === 2 && by.eeee0002.length === 2, JSON.stringify(by.eeee0001));
  ok("a single order: not offered", by.ffff0001.length === 0);
  ok("a shipped order: not offered, and not counted in the group", by.eeee0003.length === 0 && !by.eeee0001.some((g) => g.id === "eeee0003"));
  const filtered = await (await listOrders(env, new URL("https://x/api/admin/orders?status=ready"))).json();
  ok("still offered under a status filter (group read from all orders)", filtered.orders.find((o) => o.id === "eeee0002")?.ship_together.length === 2);
  ok("the group carries no email or phone", !JSON.stringify(by.eeee0001).match(/@|9876/));
}

section("dashboard form ids are unique per card");
{
  const js = readFileSync(new URL("../public/assets/js/admin.js", import.meta.url), "utf8");
  ok("checkbox id includes the card's own order id", js.includes("cb.id = `st-${o.id}-${g.id}`;"));
}

section("wiring");
{
  const idx = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  ok("the endpoint is below the owner gate", idx.indexOf('"/api/admin/orders/ship-together"') > idx.indexOf('if (p.startsWith("/api/admin/")) {'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
