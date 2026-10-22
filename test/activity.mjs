// Shopper activity: a public, insert-only endpoint and the owner's summary of it.
// Real SQLite with every migration applied, so the queries are the real ones.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { recordActivity, adminActivity } from "../src/activity.js";

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
  const p = db.prepare(`INSERT INTO products (id, slug, name, price_paise, image, visible, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  p.run("p1", "box", "Murugan Box", 49900, "a.jpg", 1, 1, 1);
  p.run("p2", "fig", "Spider-Man", 29900, "b.jpg", 1, 1, 1);
  p.run("hid", "hid", "Hidden", 100, "c.jpg", 0, 1, 1);
  db.prepare(`INSERT INTO users (id, email, name, created_at) VALUES ('u1','priya@example.com','Priya',1)`).run();
  return { db, env: { DB: d1(db) } };
}
const SID = "0123456789abcdef";
const rows = (db) => db.prepare("SELECT * FROM shopper_events ORDER BY id").all();
const summary = async (env, hours = 24) => (await adminActivity(env, new URL("https://x/api/admin/activity?hours=" + hours))).json();

section("recordActivity — only well-formed events are stored");
{
  const { db, env } = setup();
  const res = await recordActivity(env, { sid: SID, kind: "view", product_id: "p1" });
  ok("a valid view is stored", rows(db).length === 1 && rows(db)[0].product_id === "p1");
  ok("the reply reveals nothing", JSON.stringify(await res.json()) === '{"ok":true}');
  for (const [label, body] of [
    ["unknown kind", { sid: SID, kind: "purchase" }],
    ["bad sid (too short)", { sid: "abc", kind: "view" }],
    ["bad sid (uppercase)", { sid: SID.toUpperCase(), kind: "view" }],
    ["unknown product", { sid: SID, kind: "view", product_id: "nope" }],
    ["hidden product", { sid: SID, kind: "cart_add", product_id: "hid" }],
    ["no body", null],
  ]) {
    const before = rows(db).length;
    const r = await recordActivity(env, body);
    ok(`${label}: dropped, still {ok:true}`, rows(db).length === before && r.status === 200);
  }
  await recordActivity(env, { sid: SID, kind: "cart_add", product_id: "p1", qty: 9999 });
  ok("qty is clamped to 100", rows(db).at(-1).qty === 100);
  await recordActivity(env, { sid: SID, kind: "cart_add", product_id: "p1", qty: "5" });
  ok("a non-integer qty is dropped to null", rows(db).at(-1).qty === null);
  await recordActivity(env, { sid: SID, kind: "view", user_id: "u1", name: "x", email: "x@y.z", phone: "999" }, null);
  const last = rows(db).at(-1);
  ok("a user_id in the body is ignored", last.user_id === null);
  ok("the table holds only these columns (no name, email, phone or IP)",
     Object.keys(last).sort().join(",") === "created_at,id,kind,product_id,qty,receipt,sid,user_id", Object.keys(last).join(","));
  await recordActivity(env, { sid: SID, kind: "view" }, "u1");
  ok("the account id comes from the session argument", rows(db).at(-1).user_id === "u1");
}
{
  const { db, env } = setup();
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery, cust_name, cust_email, cust_phone, created_at)
    VALUES ('o1','AP-aaaaaaaa','r1','pending',1,0,1,'INR','ship','A','a@b.c','1',?)`).run(Date.now());
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery, cust_name, cust_email, cust_phone, created_at)
    VALUES ('o2','AP-bbbbbbbb','r2','paid',1,0,1,'INR','ship','B','b@b.c','2',?)`).run(Date.now() - 60 * 60 * 1000);
  await recordActivity(env, { sid: SID, kind: "pay_click", receipt: "AP-aaaaaaaa" });
  ok("pay_click keeps a just-created order's receipt", rows(db).at(-1).receipt === "AP-aaaaaaaa");
  await recordActivity(env, { sid: SID, kind: "pay_click", receipt: "AP-bbbbbbbb" });
  ok("…but not an old order's (a forged event can't claim it)", rows(db).at(-1).receipt === null);
  await recordActivity(env, { sid: SID, kind: "view", receipt: "AP-aaaaaaaa" });
  ok("a receipt on any other kind is ignored", rows(db).at(-1).receipt === null);
}
{
  const { db, env } = setup();
  db.prepare(`INSERT INTO shopper_events (sid, kind, created_at) VALUES (?, 'view', ?)`).run(SID, Date.now() - 31 * 24 * 60 * 60 * 1000);
  await recordActivity(env, { sid: SID, kind: "view" });
  ok("rows older than 30 days are pruned on write", rows(db).length === 1);
}

section("adminActivity — one row per browser, furthest step wins");
{
  const { db, env } = setup();
  const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb", C = "cccccccccccccccc";
  await recordActivity(env, { sid: A, kind: "view", product_id: "p1" });
  await recordActivity(env, { sid: A, kind: "cart_add", product_id: "p1", qty: 1 });
  await recordActivity(env, { sid: A, kind: "cart_add", product_id: "p2", qty: 1 });
  await recordActivity(env, { sid: A, kind: "cart_add", product_id: "p1", qty: 3 });
  await recordActivity(env, { sid: A, kind: "cart_remove", product_id: "p2" });
  await recordActivity(env, { sid: A, kind: "checkout_open" });
  await recordActivity(env, { sid: A, kind: "view", product_id: "p2" });   // went back to browsing
  await recordActivity(env, { sid: B, kind: "view", product_id: "p2" }, "u1");
  db.prepare(`INSERT INTO shopper_events (sid, kind, created_at) VALUES (?, 'view', ?)`).run(C, Date.now() - 3 * 60 * 60 * 1000);

  const out = await summary(env);
  const a = out.sessions.find((s) => s.sid === A), b = out.sessions.find((s) => s.sid === B);
  ok("one session per browser", out.sessions.length === 3, String(out.sessions.length));
  ok("A reached checkout even after browsing on", a.stage === "checkout", a.stage);
  ok("A's cart is the last reported state", JSON.stringify(a.cart) === '[{"name":"Murugan Box","qty":3}]', JSON.stringify(a.cart));
  ok("A viewed both products", a.viewed.join(",") === "Murugan Box,Spider-Man");
  ok("A is live", a.live === true);
  ok("B shows the signed-in name", b.user?.name === "Priya" && b.stage === "browsing");
  ok("an old session isn't live", out.sessions.find((s) => s.sid === C).live === false);
  ok("summary counts", JSON.stringify(out.summary) === '{"visitors":3,"live":2,"carts":1,"checkouts":1,"paid":0}', JSON.stringify(out.summary));
  ok("newest first", out.sessions[0].last_at >= out.sessions[1].last_at);
  const hour = await summary(env, 1);
  ok("the last-hour view leaves out the 3-hour-old session", hour.sessions.length === 2);
}
{
  const { db, env } = setup();
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery, cust_name, cust_email, cust_phone, created_at)
    VALUES ('o1','AP-cccccccc','r1','pending',1,0,1,'INR','ship','A','a@b.c','1',?)`).run(Date.now());
  await recordActivity(env, { sid: SID, kind: "pay_click", receipt: "AP-cccccccc" });
  ok("pressed Pay, order still pending", (await summary(env)).sessions[0].stage === "pressed pay");
  db.exec(`UPDATE orders SET status = 'paid'`);
  const s = (await summary(env)).sessions[0];
  ok("once the order is paid the session reads Paid", s.stage === "paid" && s.receipt === "AP-cccccccc", JSON.stringify(s));
  for (const [status, want] of [["shipped", "paid"], ["cancelled", "cancelled"], ["refunded", "refunded"]]) {
    db.prepare("UPDATE orders SET status = ?").run(status);
    const st = (await summary(env)).sessions[0].stage;
    ok(`order ${status} reads "${want}"`, st === want, st);
  }
}

section("through the worker: the account id is never taken from the request");
{
  const { db, env } = setup();
  const { default: worker } = await import("../src/index.js");
  const res = await worker.fetch(new Request("https://x/api/activity", {
    method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify({ sid: SID, kind: "view", user_id: "u1" }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  ok("accepted", res.status === 200, String(res.status));
  ok("stored without the claimed user_id (no session = guest)", rows(db).length === 1 && rows(db)[0].user_id === null, JSON.stringify(rows(db)));
}

section("a busy range keeps the newest events, not the oldest");
{
  const { db, env } = setup();
  const ins = db.prepare(`INSERT INTO shopper_events (sid, kind, created_at) VALUES (?, 'view', ?)`);
  const t0 = Date.now() - 20 * 24 * 60 * 60 * 1000;
  db.exec("BEGIN");
  for (let i = 0; i < 5005; i++) ins.run("ffffffffffffffff", t0 + i);
  db.exec("COMMIT");
  await recordActivity(env, { sid: "1111111111111111", kind: "checkout_open" });
  const out = await summary(env, 720);
  ok("the live visitor still appears past the 5000-row cap", out.sessions.some((s) => s.sid === "1111111111111111" && s.live), JSON.stringify(out.summary));
}

section("wiring");
{
  const idx = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const gate = idx.indexOf('if (p.startsWith("/api/admin/")) {');
  ok("the admin read is below the owner gate", gate > 0 && idx.indexOf('"/api/admin/activity"') > gate);
  ok("the public write is rate limited", /"\/api\/activity" && m === "POST", limiter: "RL_ACTIVITY"/.test(readFileSync(new URL("../src/security.js", import.meta.url), "utf8")));
  ok("…and the limiter exists", /name = "RL_ACTIVITY"/.test(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
