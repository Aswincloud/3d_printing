// The invoicer -> shop shipment sync (src/shipsync.js, applyStageFromInvoicer).
//
// Marking an order shipped or delivered in the INVOICER's dashboard must move the
// same order in the shop, instantly, and send the shop's email — without calling
// the invoicer back (it has just sent the WhatsApp) and without ever touching an
// order it has no business moving. The assertions that matter are the refusals.
//
//   node test/shipsync.mjs
import { shipmentSyncHandler } from "../src/shipsync.js";
import { applyStageFromInvoicer } from "../src/admin.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SECRET = "shared-test-secret";
const ORDER = (over = {}) => ({
  id: "o-1", receipt: "AP-f814ee35", status: "ready", cust_name: "Customer", cust_email: "buyer@example.com",
  total_paise: 49800, paid_at: 1, production_at: 2, ready_at: 3, shipped_at: null, delivered_at: null,
  courier: null, tracking_id: null, addr_line: "x", addr_city: "Ahmedabad", addr_state: "Gujarat", addr_pin: "380001", ...over,
});

function envWith(order, over = {}) {
  const db = { orders: order ? [{ ...order }] : [] };
  const calls = { mail: [], other: [] };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT * FROM orders WHERE receipt = ?")) {
      const o = db.orders.find((x) => x.receipt === a[0]);
      // raceTo: the order changes right after this read, before the UPDATE.
      const copy = o ? { ...o } : null;
      if (o && db.raceTo) { o.status = db.raceTo; db.raceTo = null; }
      return { first: copy };
    }
    if (s.startsWith("SELECT status FROM orders WHERE id = ?")) { const o = db.orders.find((x) => x.id === a[0]); return { first: o ? { status: o.status } : null }; }
    if (s.startsWith("UPDATE orders SET status = ?")) {
      const [id, prev] = a.slice(-2); const o = db.orders.find((x) => x.id === id);
      if (!o || o.status !== prev) return { meta: { changes: 0 } };
      // Split on the commas BETWEEN assignments, not the one inside COALESCE(col, ?).
      const cols = s.slice("UPDATE orders SET ".length, s.indexOf(" WHERE")).split(/, (?=[a-z_]+ = )/);
      cols.forEach((c, i) => { const col = c.split(" ")[0]; o[col] = c.includes("COALESCE") ? (o[col] ?? a[i]) : a[i]; });
      return { meta: { changes: 1 } };
    }
    throw new Error("unhandled SQL: " + s.slice(0, 90));
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.resend.com") { calls.mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
    calls.other.push(String(url)); return new Response("{}", { status: 200 });
  };
  return { INVOICE_ENABLED: "true", SHOP_INGEST_SECRET: SECRET, RESEND_API_KEY: "re_test", OWNER_EMAIL: "owner@example.com",
    APP_BASE_URL: "https://shop.test", ...over, _db: db, _c: calls,
    DB: { prepare(sql) { const make = (args) => ({ bind: (...a) => make(a), async first() { return run(sql, args).first ?? null; }, async run() { return run(sql, args); }, async all() { return { results: [] }; } }); return make([]); } } };
}
async function signed(body, { secret = SECRET, prefix = "invoicer->shop\n", sig = null } = {}) {
  const raw = JSON.stringify(body);
  return new Request("https://shop/api/sync/shipment", { method: "POST", body: raw,
    headers: { "x-invoicer-signature": sig ?? (await hmacHex(prefix + raw, secret)) } });
}
const call = async (env, body, opts) => {
  const jobs = []; const r = await shipmentSyncHandler(await signed(body, opts), env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs); return [r.status, await r.json()];
};
const SHIP = (over = {}) => ({ ts: Date.now(), receipt: "AP-f814ee35", kind: "shipped", courier: "The Professional Couriers", tracking: "TPC12345", ...over });

section("shipped from the invoicer moves the shop order, emails, and does not call back");
{
  const env = envWith(ORDER());
  const [st, b] = await call(env, SHIP());
  const o = env._db.orders[0];
  ok("200", st === 200, JSON.stringify(b));
  ok("ready -> shipped", o.status === "shipped");
  ok("shipped_at stamped", o.shipped_at > 0);
  ok("courier and tracking recorded", o.courier === "The Professional Couriers" && o.tracking_id === "TPC12345");
  ok("the shop's shipped email went to the customer", env._c.mail.length === 1 && /shipped/i.test(env._c.mail[0].subject) && JSON.stringify(env._c.mail[0].to).includes("buyer@example.com"), JSON.stringify(env._c.mail.map((m) => [m.subject, m.to])));
  ok("the email names the tracking number", /TPC12345/.test(env._c.mail[0].text));
  ok("the owner gets a blind copy of it", JSON.stringify(env._c.mail[0].bcc) === JSON.stringify(["owner@example.com"]), JSON.stringify(env._c.mail[0].bcc));
  ok("NO call back to the invoicer (no loop, no second WhatsApp)", env._c.other.length === 0, JSON.stringify(env._c.other));
  const [st2, b2] = await call(env, SHIP());
  ok("a retry is harmless: already, no second email", st2 === 200 && b2.already === true && env._c.mail.length === 1, JSON.stringify(b2));
}
section("delivered");
{
  const env = envWith(ORDER({ status: "shipped", shipped_at: 9 }));
  await call(env, SHIP({ kind: "delivered" }));
  ok("shipped -> delivered, one delivered email", env._db.orders[0].status === "delivered" && env._db.orders[0].delivered_at > 0 && env._c.mail.length === 1 && /Delivered/.test(env._c.mail[0].subject));
  ok("shipped_at kept", env._db.orders[0].shipped_at === 9);
}
{
  const env = envWith(ORDER());
  await call(env, SHIP({ kind: "delivered" }));
  const o = env._db.orders[0];
  ok("delivered straight from ready also stamps shipped_at", o.status === "delivered" && o.shipped_at > 0 && o.delivered_at > 0);
}
{
  const env = envWith(ORDER({ status: "delivered", shipped_at: 1, delivered_at: 2 }));
  const [, b] = await call(env, SHIP());
  ok("shipped on an already-delivered order changes nothing", b.already === true && env._db.orders[0].status === "delivered" && env._c.mail.length === 0);
}
section("refusals: what it must never do");
for (const status of ["cancelled", "refunded", "pending", "failed"]) {
  const env = envWith(ORDER({ status }));
  const [st] = await call(env, SHIP());
  ok(`a ${status} order is not moved`, st === 409 && env._db.orders[0].status === status && env._c.mail.length === 0, String(st));
}
{
  const env = envWith(ORDER());
  ok("bad signature 401", (await call(env, SHIP(), { sig: "00" }))[0] === 401);
  ok("wrong secret 401", (await call(env, SHIP(), { secret: "nope" }))[0] === 401);
  ok("a body signed the shop->invoicer way (no prefix) is refused", (await call(env, SHIP(), { prefix: "" }))[0] === 401);
  ok("stale timestamp 401", (await call(env, SHIP({ ts: Date.now() - 10 * 60 * 1000 })))[0] === 401);
  ok("bad kind 400", (await call(env, SHIP({ kind: "paid" })))[0] === 400);
  ok("bad receipt 400", (await call(env, SHIP({ receipt: "'; DROP TABLE orders;--" })))[0] === 400);
  ok("unknown order 404", (await call(env, SHIP({ receipt: "AP-00000000" })))[0] === 404);
  ok("none of those touched the order", env._db.orders[0].status === "ready" && env._c.mail.length === 0);
}
ok("disabled when INVOICE_ENABLED is off", (await call(envWith(ORDER(), { INVOICE_ENABLED: "false" }), SHIP()))[0] === 503);
ok("disabled when the secret is unset", (await call(envWith(ORDER(), { SHOP_INGEST_SECRET: "" }), SHIP()))[0] === 503);
section("the order changes between read and write");
{
  const env = envWith(ORDER()); env._db.raceTo = "cancelled";
  const [st, b] = await call(env, SHIP());
  ok("cancelled meanwhile: 409, not 'already'", st === 409 && !b.already, `${st} ${JSON.stringify(b)}`);
  ok("and no email", env._c.mail.length === 0);
}
{
  const env = envWith(ORDER()); env._db.raceTo = "shipped";
  const [st, b] = await call(env, SHIP());
  ok("shipped meanwhile by another call: 200 already", st === 200 && b.already === true, JSON.stringify(b));
  ok("and no second email", env._c.mail.length === 0);
}

section("silent reconcile (email: false)");
{
  const env = envWith(ORDER());
  const r = await applyStageFromInvoicer(env, { receipt: "AP-f814ee35", kind: "shipped", courier: "The Professional Couriers", tracking: "T1", email: false });
  ok("moved", (await r.json()).status === "shipped" && env._db.orders[0].status === "shipped");
  ok("no email, no outbound call of any kind", env._c.mail.length === 0 && env._c.other.length === 0);
}
console.log(`\n  shipsync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
