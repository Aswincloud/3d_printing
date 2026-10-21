// Automated reminders: an unpaid checkout 30 min on, an untouched cart 1 h on.
//
// Run against REAL SQLite with every migration applied — the decisions here
// are all SQL (is it still pending, is there a newer order, did the claim
// UPDATE win), and a hand-written fake would answer whatever the test assumed.
// The queue, Resend and the invoicer are stubbed at fetch / binding level.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  runUnpaid, runCart, backPage, stopReminders, stopConfirmPage, handleReminderBatch,
  scheduleUnpaidReminder, itemsLabel, UNPAID_DELAY_S, CART_DELAY_S, CART_COOLDOWN_MS,
} from "../src/reminders.js";
import { putCart } from "../src/cart.js";
import { updateMe } from "../src/customers.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SECRET = "test-secret";
const T0 = Date.now() - 2 * 60 * 60 * 1000;   // two hours ago

// A D1-shaped wrapper over node:sqlite: prepare().bind().first/all/run, batch.
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  const p = db.prepare(`INSERT INTO products (id, slug, name, price_paise, image, visible, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  p.run("p1", "murugan", "Murugan Vibhuti Box", 49900, "a.jpg", 1, 1, 1);
  p.run("p2", "spidey", "Spider-Man\n  Figurine", 29900, "b.jpg", 1, 1, 1);
  p.run("p3", "hidden", "Hidden Thing", 9900, "c.jpg", 0, 1, 1);
  return db;
}

function setup(over = {}) {
  const db = freshDb();
  const calls = { mail: [], invoicer: [], queued: [] };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === "api.resend.com") { calls.mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}'); }
    if (u.hostname === "invoicer.test") {
      calls.invoicer.push({ path: u.pathname, body: JSON.parse(init.body), sig: init.headers["x-shop-signature"], redirect: init.redirect });
      return new Response(JSON.stringify({ ok: true, whatsapp: "sent" }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  const env = {
    DB: d1(db), RESEND_API_KEY: "k", OWNER_EMAIL: "owner@example.com", APP_BASE_URL: "https://shop.test",
    REMINDERS_ENABLED: "true", INVOICE_ENABLED: "true", INVOICER_URL: "https://invoicer.test", SHOP_INGEST_SECRET: SECRET,
    REMINDERS: { async send(body, opts) { calls.queued.push({ body, opts }); } },
    ...over,
  };
  return { db, env, calls };
}

const TOKEN = "a".repeat(32);
function seedOrder(db, over = {}) {
  const o = { id: "o1", receipt: "AP-11111111", status: "pending", user_id: null, total_paise: 59800,
    cust_name: "Priya", cust_email: "priya@example.com", cust_phone: "9876543210", pay_token: TOKEN,
    wa_offers: 0, created_at: T0, ...over };
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery,
      cust_name, cust_email, cust_phone, created_at, user_id, pay_token, wa_offers)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.id, o.receipt, "order_" + o.id, o.status, o.total_paise, 0, o.total_paise, "INR", "ship",
      o.cust_name, o.cust_email, o.cust_phone, o.created_at, o.user_id, o.pay_token, o.wa_offers);
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, pos) VALUES (?,?,?,?,?,?,?)`)
    .run("i-" + o.id, o.id, "p1", "Murugan Vibhuti Box", 49900, 1, 0);
  return o;
}
function seedUser(db, over = {}) {
  const u = { id: "u1", email: "priya@example.com", name: "Priya", phone: "9876543210", wa_offers: 0, ...over };
  db.prepare(`INSERT INTO users (id, email, name, phone, wa_offers, created_at) VALUES (?,?,?,?,?,?)`)
    .run(u.id, u.email, u.name, u.phone, u.wa_offers, 1);
  return u;
}

// ══ scheduling ═══════════════════════════════════════════════════
section("scheduling — one delayed message, never a failure");
{
  const { env, calls } = setup();
  await scheduleUnpaidReminder(env, "o1");
  ok("the unpaid reminder is queued 30 minutes out", calls.queued.length === 1 && calls.queued[0].opts.delaySeconds === UNPAID_DELAY_S && UNPAID_DELAY_S === 1800, JSON.stringify(calls.queued));
  ok("it carries only the order id", JSON.stringify(calls.queued[0].body) === '{"kind":"unpaid","order_id":"o1"}');

  const off = setup({ REMINDERS_ENABLED: "false" });
  await scheduleUnpaidReminder(off.env, "o1");
  ok("kill switch: nothing queued", off.calls.queued.length === 0);

  const broken = setup({ REMINDERS: { async send() { throw new Error("queue down"); } } });
  ok("a queue failure does not throw", (await scheduleUnpaidReminder(broken.env, "o1")) === false);
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  await putCart(env, { id: "u1" }, { items: [{ product_id: "p1", qty: 2 }] });
  const stamp = db.prepare("SELECT updated_at FROM cart_items WHERE user_id='u1'").get().updated_at;
  ok("a cart save queues a cart reminder an hour out", calls.queued.length === 1 && calls.queued[0].opts.delaySeconds === CART_DELAY_S && CART_DELAY_S === 3600);
  ok("stamped with the cart's own updated_at", calls.queued[0].body.kind === "cart" && calls.queued[0].body.stamp === stamp, JSON.stringify(calls.queued[0].body));
  await putCart(env, { id: "u1" }, { items: [] });
  ok("emptying the cart queues nothing", calls.queued.length === 1);
}

// ══ unpaid ═══════════════════════════════════════════════════════
section("unpaid — sent once, to the customer, with the owner copied");
{
  const { db, env, calls } = setup();
  seedOrder(db);
  const r = await runUnpaid(env, "o1");
  ok("sent", r.sent === true, JSON.stringify(r));
  ok("one email, to the customer", calls.mail.length === 1 && JSON.stringify(calls.mail[0].to) === '["priya@example.com"]');
  ok("the owner gets a blind copy", JSON.stringify(calls.mail[0].bcc) === '["owner@example.com"]');
  ok("it names COMEBACK", /COMEBACK/.test(calls.mail[0].html) && /COMEBACK/.test(calls.mail[0].text));
  ok("the offer link restores this order", calls.mail[0].html.includes(`https://shop.test/back/o${TOKEN}`));
  ok("and the original pay link is offered too", calls.mail[0].html.includes(`https://shop.test/o/${TOKEN}`));
  ok("an unsubscribe link", calls.mail[0].html.includes(`/back/o${TOKEN}/stop`));
  ok("no consent: WhatsApp is the plain utility reminder", calls.invoicer.length === 1 && calls.invoicer[0].path === "/api/ingest/payment-reminder", JSON.stringify(calls.invoicer.map((c) => c.path)));
  ok("it never names the coupon", !JSON.stringify(calls.invoicer[0].body).includes("COMEBACK"));
  ok("signed, redirects refused", /^[0-9a-f]{64}$/.test(calls.invoicer[0].sig) && calls.invoicer[0].redirect === "manual");
  ok("recorded", db.prepare("SELECT auto_reminder_at FROM orders WHERE id='o1'").get().auto_reminder_at > 0);

  const again = await runUnpaid(env, "o1");
  ok("a second delivery sends nothing", again.sent === false && calls.mail.length === 1 && calls.invoicer.length === 1, JSON.stringify(again));
}
{
  const { db, env, calls } = setup();
  seedOrder(db, { wa_offers: 1 });
  await runUnpaid(env, "o1");
  const c = calls.invoicer[0];
  ok("opted in: WhatsApp is the offer", calls.invoicer.length === 1 && c.path === "/api/ingest/comeback", JSON.stringify(calls.invoicer.map((x) => x.path)));
  ok("it carries the /back/ token and what was in it", c.body.token === "o" + TOKEN && c.body.what === "Murugan Vibhuti Box", JSON.stringify(c.body));
}
for (const [label, prep, why] of [
  ["paid in the meantime", (db) => seedOrder(db, { status: "paid" }), "not pending"],
  ["cancelled", (db) => seedOrder(db, { status: "cancelled" }), "not pending"],
  ["already reminded by hand", (db) => { seedOrder(db); db.exec("UPDATE orders SET pay_reminder_at = 1"); }, "already reminded by hand"],
  ["a newer order from the same email", (db) => { seedOrder(db); seedOrder(db, { id: "o2", receipt: "AP-22222222", pay_token: "b".repeat(32), cust_email: "PRIYA@example.com", created_at: T0 + 1000, status: "paid" }); }, "a newer order exists"],
  ["unsubscribed (account by email)", (db) => { seedOrder(db); seedUser(db); db.exec("UPDATE users SET reminders_off = 1"); }, "unsubscribed"],
]) {
  const { db, env, calls } = setup();
  prep(db);
  const r = await runUnpaid(env, "o1");
  ok(`${label}: nothing sent (${why})`, r.sent === false && r.why === why && calls.mail.length === 0 && calls.invoicer.length === 0, JSON.stringify(r));
}
{
  const { db, env, calls } = setup({ REMINDERS_ENABLED: "" });
  seedOrder(db);
  const r = await runUnpaid(env, "o1");
  ok("kill switch also stops a message already queued", r.sent === false && calls.mail.length === 0);
}
{
  // A newer order from SOMEONE ELSE must not suppress this one.
  const { db, env, calls } = setup();
  seedOrder(db);
  seedOrder(db, { id: "o2", receipt: "AP-22222222", pay_token: "b".repeat(32), cust_email: "other@example.com", created_at: T0 + 1000 });
  await runUnpaid(env, "o1");
  ok("another customer's newer order does not suppress it", calls.mail.length === 1);
}

// ══ cart ═════════════════════════════════════════════════════════
section("cart — once per cart state, signed-in only");
async function cartAt(db, env, items) {
  await putCart(env, { id: "u1" }, { items });
  return db.prepare("SELECT MAX(updated_at) s FROM cart_items WHERE user_id='u1'").get().s;
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  const stamp = await cartAt(db, env, [{ product_id: "p1", qty: 1 }, { product_id: "p2", qty: 2 }]);
  const r = await runCart(env, "u1", stamp);
  ok("sent", r.sent === true, JSON.stringify(r));
  const m = calls.mail[0];
  ok("to the account's email, owner copied", JSON.stringify(m.to) === '["priya@example.com"]' && JSON.stringify(m.bcc) === '["owner@example.com"]');
  ok("lists the items", m.html.includes("Murugan Vibhuti Box") && m.text.includes("x 2"));
  const tok = db.prepare("SELECT back_token FROM users WHERE id='u1'").get().back_token;
  ok("mints a back token and links it", /^[0-9a-f]{32}$/.test(tok) && m.html.includes(`/back/u${tok}`));
  ok("no consent: no WhatsApp at all", calls.invoicer.length === 0);

  const again = await runCart(env, "u1", stamp);
  ok("the same stamp again sends nothing", again.sent === false && calls.mail.length === 1, JSON.stringify(again));
}
{
  const { db, env, calls } = setup();
  seedUser(db, { wa_offers: 1 });
  const stamp = await cartAt(db, env, [{ product_id: "p2", qty: 1 }]);
  await runCart(env, "u1", stamp);
  const c = calls.invoicer[0];
  ok("opted in: the offer goes on WhatsApp", calls.invoicer.length === 1 && c?.path === "/api/ingest/comeback");
  ok("item label is one line (Meta rejects newlines)", c?.body.what === "Spider-Man Figurine", JSON.stringify(c?.body.what));
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  const old = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  db.exec(`UPDATE cart_items SET updated_at = updated_at + 5000`);   // changed after scheduling
  const r = await runCart(env, "u1", old);
  ok("cart changed since: the older message does nothing", r.sent === false && r.why === "cart changed since" && calls.mail.length === 0, JSON.stringify(r));
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  const stamp = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  seedOrder(db, { user_id: "u1", created_at: stamp + 1, status: "paid" });
  const r = await runCart(env, "u1", stamp);
  ok("ordered since the cart changed: nothing", r.sent === false && r.why === "ordered since" && calls.mail.length === 0, JSON.stringify(r));
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  const stamp = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  seedOrder(db, { user_id: null, cust_email: "PRIYA@EXAMPLE.COM", created_at: stamp + 1 });
  const r = await runCart(env, "u1", stamp);
  ok("…including a guest checkout with the same email", r.sent === false && r.why === "ordered since", JSON.stringify(r));
}
{
  const { db, env, calls } = setup();
  seedUser(db);
  const s1 = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  await runCart(env, "u1", s1);
  db.exec(`UPDATE cart_items SET updated_at = updated_at + 7000`);
  const s2 = db.prepare("SELECT MAX(updated_at) s FROM cart_items").get().s;
  const r = await runCart(env, "u1", s2);
  ok("a changed cart inside 3 days is not reminded again", r.sent === false && r.why === "reminded recently" && calls.mail.length === 1, JSON.stringify(r));
  db.prepare(`UPDATE users SET cart_reminded_at = ?`).run(Date.now() - CART_COOLDOWN_MS - 1000);
  const r2 = await runCart(env, "u1", s2);
  ok("after 3 days it can be reminded again", r2.sent === true && calls.mail.length === 2, JSON.stringify(r2));
}
for (const [label, prep, why] of [
  ["unsubscribed", (db) => db.exec("UPDATE users SET reminders_off = 1"), "unsubscribed"],
  ["only hidden items", (db) => db.exec("UPDATE products SET visible = 0"), "cart empty"],
]) {
  const { db, env, calls } = setup();
  seedUser(db);
  const stamp = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  prep(db);
  const r = await runCart(env, "u1", stamp);
  ok(`${label}: nothing`, r.sent === false && r.why === why && calls.mail.length === 0, JSON.stringify(r));
}

// ══ queue consumer ═══════════════════════════════════════════════
section("queue consumer — ack on success, retry on error");
{
  const { db, env } = setup();
  seedOrder(db);
  const acks = [];
  const msg = (body) => ({ body, ack: () => acks.push(["ack", body.kind]), retry: () => acks.push(["retry", body.kind]) });
  await handleReminderBatch({ messages: [msg({ kind: "unpaid", order_id: "o1" }), msg({ kind: "unknown" })] }, env);
  ok("both acked (an unknown kind is dropped, not retried forever)", JSON.stringify(acks) === '[["ack","unpaid"],["ack","unknown"]]', JSON.stringify(acks));
  const broken = { ...env, DB: { prepare() { throw new Error("D1 down"); } } };
  acks.length = 0;
  await handleReminderBatch({ messages: [msg({ kind: "unpaid", order_id: "o1" })] }, broken);
  ok("a D1 failure is retried", JSON.stringify(acks) === '[["retry","unpaid"]]', JSON.stringify(acks));
}

// ══ /back/ ═══════════════════════════════════════════════════════
section("/back/<token> — restores items, never prices");
const cfgOf = async (res) => {
  const html = await res.text();
  const m = html.match(/data-cfg="([^"]*)"/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) : null;
};
{
  const { db, env } = setup();
  seedOrder(db);
  const res = await backPage(env, "o" + TOKEN);
  const cfg = await cfgOf(res);
  ok("a guest order's lines come back", res.status === 200 && JSON.stringify(cfg?.cart) === '[{"id":"p1","qty":1,"pz":""}]', JSON.stringify(cfg));
  ok("with the code", cfg?.code === "COMEBACK");
  ok("a guest order's link is NOT an account's own cart (it must merge, not replace)", cfg?.own === false);
  ok("no price anywhere in it", !JSON.stringify(cfg).includes("price") && !JSON.stringify(cfg).includes("4990"));
  ok("not indexed, not cached", res.headers.get("x-robots-tag")?.includes("noindex") && res.headers.get("cache-control") === "no-store");
}
{
  const { db, env } = setup();
  seedUser(db);
  await putCart(env, { id: "u1" }, { items: [{ product_id: "p1", qty: 3 }] });
  db.exec(`UPDATE users SET back_token = '${"c".repeat(32)}'`);
  const cfg = await cfgOf(await backPage(env, "u" + "c".repeat(32)));
  ok("an account's cart comes back", JSON.stringify(cfg?.cart) === '[{"id":"p1","qty":3,"pz":""}]', JSON.stringify(cfg));
  ok("an account's link is marked as its own cart", cfg?.own === true);
  db.exec(`DELETE FROM cart_items`);
  seedOrder(db, { user_id: "u1" });
  const cfg2 = await cfgOf(await backPage(env, "u" + "c".repeat(32)));
  ok("…or, cart emptied, their pending order's lines", JSON.stringify(cfg2?.cart) === '[{"id":"p1","qty":1,"pz":""}]', JSON.stringify(cfg2));
}
{
  const { db, env } = setup();
  seedOrder(db);
  db.exec(`UPDATE products SET visible = 0`);
  const res = await backPage(env, "o" + TOKEN);
  ok("a hidden product is not restored", res.status === 200 && (await res.text()).includes("aren't available"));
  for (const bad of ["o" + "a".repeat(31), "x" + TOKEN, "o" + "A".repeat(32), "u" + "d".repeat(32)]) {
    ok(`bad or unknown token ${bad.slice(0, 6)}… → 404`, (await backPage(env, bad)).status === 404);
  }
}

section("/back/<token>/stop — confirm on GET, act on POST");
{
  ok("GET shows a button and changes nothing", (await stopConfirmPage("o" + TOKEN).text()).includes('method="post"'));
  ok("GET with a bad token → 404", stopConfirmPage("nope").status === 404);
  const { db, env, calls } = setup();
  seedUser(db, { wa_offers: 1 });
  db.exec(`UPDATE users SET back_token = '${"c".repeat(32)}'`);
  await stopReminders(env, "u" + "c".repeat(32));
  const u = db.prepare("SELECT reminders_off, wa_offers FROM users").get();
  ok("an account: reminders off and WhatsApp offers off", u.reminders_off === 1 && u.wa_offers === 0, JSON.stringify(u));
  const stamp = await cartAt(db, env, [{ product_id: "p1", qty: 1 }]);
  ok("…and the cart reminder then stays quiet", (await runCart(env, "u1", stamp)).why === "unsubscribed");
}
{
  const { db, env, calls } = setup();
  seedOrder(db, { wa_offers: 1 });
  seedUser(db, { email: "Priya@Example.com" });
  await stopReminders(env, "o" + TOKEN);
  ok("a guest: this order will not be reminded", (await runUnpaid(env, "o1")).sent === false && calls.mail.length === 0);
  ok("and an account with that email is unsubscribed too", db.prepare("SELECT reminders_off FROM users").get().reminders_off === 1);
}

// ══ consent ══════════════════════════════════════════════════════
section("WhatsApp-offers consent — only a literal boolean");
{
  const { db, env } = setup();
  seedUser(db);
  for (const v of ["true", 1, "yes", null]) {
    await updateMe(env, { id: "u1" }, { wa_offers: v, name: "Priya" });
    ok(`wa_offers ${JSON.stringify(v)} does not opt in`, db.prepare("SELECT wa_offers FROM users").get().wa_offers === 0);
  }
  await updateMe(env, { id: "u1" }, { wa_offers: true });
  ok("true opts in", db.prepare("SELECT wa_offers FROM users").get().wa_offers === 1);
  db.exec("UPDATE users SET reminders_off = 1");
  await updateMe(env, { id: "u1" }, { wa_offers: true });
  ok("opting in again turns reminders back on", db.prepare("SELECT reminders_off FROM users").get().reminders_off === 0);
  await updateMe(env, { id: "u1" }, { wa_offers: false });
  ok("false opts out", db.prepare("SELECT wa_offers FROM users").get().wa_offers === 0);
}

section("itemsLabel()");
ok("one item", itemsLabel([{ name: "Box" }]) === "Box");
ok("three items", itemsLabel([{ name: "Box" }, { name: "A" }, { name: "B" }]) === "Box and 2 more items");
ok("whitespace collapsed", itemsLabel([{ name: "A\t\n   B" }]) === "A B");
ok("empty", itemsLabel([]) === "your items");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
