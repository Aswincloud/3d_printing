// Integration tests for the order lifecycle, with the Razorpay API stubbed at
// the fetch boundary and D1 replaced by a small in-memory SQL-ish fake.
//
// These cover the parts that can't be checked by clicking through a real
// checkout: that a tampered amount is ignored, that the browser callback can't
// mark an order paid, that webhook redelivery doesn't double-email, and that
// the raw-body HMAC actually gates the webhook.

import { createOrderHandler, verifyOrderHandler, getOrderHandler, razorpayWebhook } from "../src/orders.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const KEY_SECRET = "test_key_secret_value";
const WEBHOOK_SECRET = "test_webhook_secret_value";

const PRODUCTS = [
  { id: "p-small", name: "Kingfisher", price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant", price_paise: 89900, visible: 1 },
  { id: "p-hidden", name: "Spider-Man", price_paise: 54900, visible: 0 },
];

// ── in-memory D1 ──────────────────────────────────────────────────
// Only the handful of statement shapes the handlers actually use. Anything
// unrecognised throws loudly rather than silently returning nothing, so a
// query change can't quietly break a test into passing.

// Real D1 returns only the selected columns. The fake must too, or a test
// asserting "this query doesn't leak the address" passes/fails for the wrong
// reason.
const project = (row, cols) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));

// Pull the column list out of `SELECT a, b, c FROM ...`.
const columnsOf = (sql) =>
  sql.slice(6, sql.indexOf(" FROM ")).split(",").map((c) => c.trim().split(/\s+/).pop());

function makeDB() {
  const db = { products: [...PRODUCTS], orders: [], order_items: [], webhook_events: [] };

  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT id, name, price_paise FROM products")) {
      const want = new Set(args);
      return { results: db.products.filter((p) => p.visible === 1 && want.has(p.id)) };
    }
    if (s.startsWith("INSERT INTO orders")) {
      const [id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise,
        total_paise, currency, delivery, cust_name, cust_email, cust_phone,
        addr_line, addr_city, addr_state, addr_pin, notes, created_at] = args;
      db.orders.push({ id, receipt, rzp_order_id, rzp_payment_id: null, status,
        subtotal_paise, shipping_paise, total_paise, currency, delivery,
        cust_name, cust_email, cust_phone, addr_line, addr_city, addr_state,
        addr_pin, notes, created_at, paid_at: null });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO order_items")) {
      const [id, order_id, product_id, name, price_paise, qty, pos] = args;
      db.order_items.push({ id, order_id, product_id, name, price_paise, qty, pos });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("SELECT id, receipt, status, total_paise FROM orders WHERE rzp_order_id")) {
      return { first: db.orders.find((o) => o.rzp_order_id === args[0]) || null };
    }
    if (s.startsWith("SELECT * FROM orders WHERE rzp_order_id")) {
      return { first: db.orders.find((o) => o.rzp_order_id === args[0]) || null };
    }
    if (s.startsWith("UPDATE orders SET rzp_payment_id = COALESCE")) {
      const o = db.orders.find((x) => x.id === args[1]);
      if (o && !o.rzp_payment_id) o.rzp_payment_id = args[0];
      return { meta: { changes: o ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE orders SET status='paid'")) {
      const o = db.orders.find((x) => x.id === args[2] && x.status === "pending");
      if (!o) return { meta: { changes: 0 } };
      o.status = "paid"; o.paid_at = args[0];
      if (args[1]) o.rzp_payment_id = args[1];
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT OR IGNORE INTO webhook_events")) {
      if (db.webhook_events.some((e) => e.event_id === args[0])) return { meta: { changes: 0 } };
      db.webhook_events.push({ event_id: args[0], event_type: args[1], received_at: args[2] });
      return { meta: { changes: 1 } };
    }
    // The receipt-subquery form must be matched BEFORE the plain order_id
    // form, since the latter is a prefix of it.
    if (s.startsWith("SELECT name, price_paise, qty FROM order_items WHERE order_id = (SELECT id FROM orders WHERE receipt")) {
      const o = db.orders.find((x) => x.receipt === args[0]);
      const rows = o ? db.order_items.filter((i) => i.order_id === o.id).sort((a, b) => a.pos - b.pos) : [];
      return { results: rows.map((r) => project(r, ["name", "price_paise", "qty"])) };
    }
    if (s.startsWith("SELECT name, price_paise, qty FROM order_items WHERE order_id")) {
      const rows = db.order_items.filter((i) => i.order_id === args[0]).sort((a, b) => a.pos - b.pos);
      return { results: rows.map((r) => project(r, ["name", "price_paise", "qty"])) };
    }
    if (s.startsWith("SELECT receipt, status,")) {
      const o = db.orders.find((x) => x.receipt === args[0]);
      // Project exactly the listed columns — otherwise a test asserting that a
      // column is NOT exposed would fail against the fake even though the real
      // query never selects it.
      return { first: o ? project(o, columnsOf(s)) : null };
    }
    throw new Error("unhandled SQL in fake D1: " + s.slice(0, 90));
  };

  const prepare = (sql) => ({
    bind(...args) { this._a = args; return this; },
    async all() { return { results: run(sql, this._a || []).results || [] }; },
    async first() { return run(sql, this._a || []).first ?? null; },
    async run() { return run(sql, this._a || []); },
  });

  return {
    _db: db,
    prepare,
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

const ENV = () => ({
  RAZORPAY_KEY_ID: "rzp_test_fake",
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RESEND_API_KEY: "re_fake",
  OWNER_EMAIL: "owner@example.com",
  FLAT_SHIP_PAISE: "9900",
  FREE_SHIP_THRESHOLD_PAISE: "150000",
  DB: makeDB(),
});

const CUSTOMER = {
  name: "Test Buyer", email: "buyer@example.com", phone: "9876543210",
  addr_line: "12 Main Street", addr_city: "Pondicherry",
  addr_state: "Puducherry", addr_pin: "605001",
};

// Stub Razorpay + Resend at the fetch boundary; record what each is sent.
function stubFetch() {
  const calls = { razorpay: [], resend: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.razorpay.com")) {
      const body = JSON.parse(init.body || "{}");
      calls.razorpay.push({ url: u, body, headers: init.headers });
      return new Response(JSON.stringify({
        id: "order_STUB" + calls.razorpay.length, amount: body.amount,
        currency: "INR", receipt: body.receipt, status: "created",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("api.resend.com")) {
      calls.resend.push(JSON.parse(init.body || "{}"));
      return new Response(JSON.stringify({ id: "email_stub" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  return calls;
}

// Collect ctx.waitUntil promises so email assertions can await them.
const makeCtx = () => { const p = []; return { waitUntil: (x) => p.push(x), _p: p }; };
const settle = async (ctx) => { await Promise.all(ctx._p); };

const post = (body) => new Request("http://x/api/orders", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const readJson = async (res) => [res.status, await res.json()];

// ── order creation ────────────────────────────────────────────────
section("POST /api/orders — happy path");
{
  const env = ENV(); const calls = stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 2 }], delivery: "ship", customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));

  ok("200", status === 200, JSON.stringify(out));
  ok("returns the razorpay order id", out.rzp_order_id === "order_STUB1", out.rzp_order_id);
  ok("returns the public key id", out.key_id === "rzp_test_fake");
  ok("NEVER returns the key secret", !JSON.stringify(out).includes(KEY_SECRET));
  ok("amount = 2×34900 + 9900 shipping", out.amount === 79700, String(out.amount));
  ok("receipt looks right", /^AP-[0-9a-f]{8}$/.test(out.receipt), out.receipt);

  ok("razorpay got the same amount", calls.razorpay[0].body.amount === 79700);
  ok("order row is pending", env.DB._db.orders[0].status === "pending");
  ok("line item snapshots the name", env.DB._db.order_items[0].name === "Kingfisher");
  ok("line item snapshots the price", env.DB._db.order_items[0].price_paise === 34900);
  ok("no email sent at creation", calls.resend.length === 0);
}

section("POST /api/orders — the client cannot set the price (invariant 1)");
{
  const env = ENV(); const calls = stubFetch();
  const body = {
    items: [{ product_id: "p-large", qty: 1, price_paise: 1, price: 1, amount: 1 }],
    delivery: "ship", customer: CUSTOMER,
    amount: 1, total_paise: 1, subtotal_paise: 1, shipping_paise: 0,
  };
  const [, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("charged from D1, not the payload", out.amount === 99800, String(out.amount));
  ok("razorpay charged the D1 amount", calls.razorpay[0].body.amount === 99800);
  ok("stored total is the D1 amount", env.DB._db.orders[0].total_paise === 99800);
}

section("POST /api/orders — pickup and free shipping");
{
  const env = ENV(); stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup", customer: CUSTOMER };
  const [, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("pickup has no shipping", out.shipping_paise === 0);
  ok("pickup total = subtotal", out.total_paise === 34900);
  ok("pickup discards the address", env.DB._db.orders[0].addr_line === "");
}
{
  const env = ENV(); stubFetch();
  const body = { items: [{ product_id: "p-large", qty: 2 }], delivery: "ship", customer: CUSTOMER };
  const [, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("over threshold ships free", out.shipping_paise === 0);
  ok("total = 179800", out.total_paise === 179800, String(out.total_paise));
}

section("POST /api/orders — validation");
{
  const cases = [
    ["empty cart", { items: [], delivery: "ship", customer: CUSTOMER }],
    ["hidden product", { items: [{ product_id: "p-hidden", qty: 1 }], delivery: "ship", customer: CUSTOMER }],
    ["unknown product", { items: [{ product_id: "nope", qty: 1 }], delivery: "ship", customer: CUSTOMER }],
    ["no name", { items: [{ product_id: "p-small", qty: 1 }], delivery: "ship", customer: { ...CUSTOMER, name: "" } }],
    ["bad email", { items: [{ product_id: "p-small", qty: 1 }], delivery: "ship", customer: { ...CUSTOMER, email: "nope" } }],
    ["short phone", { items: [{ product_id: "p-small", qty: 1 }], delivery: "ship", customer: { ...CUSTOMER, phone: "123" } }],
    ["no address when shipping", { items: [{ product_id: "p-small", qty: 1 }], delivery: "ship", customer: { ...CUSTOMER, addr_line: "" } }],
    ["bad pin", { items: [{ product_id: "p-small", qty: 1 }], delivery: "ship", customer: { ...CUSTOMER, addr_pin: "12" } }],
  ];
  for (const [label, body] of cases) {
    const env = ENV(); const calls = stubFetch();
    const [status] = await readJson(await createOrderHandler(post(body), env, body));
    ok(`${label} → 400`, status === 400);
    ok(`${label} makes no Razorpay call`, calls.razorpay.length === 0);
    ok(`${label} writes no order`, env.DB._db.orders.length === 0);
  }
}

section("POST /api/orders — pickup needs no address");
{
  const env = ENV(); stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup",
    customer: { name: "A B", email: "a@b.com", phone: "9876543210" } };
  const [status] = await readJson(await createOrderHandler(post(body), env, body));
  ok("pickup without an address is accepted", status === 200);
}

section("POST /api/orders — unconfigured keys");
{
  const env = { ...ENV(), RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" };
  const calls = stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup", customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("503, not a crash", status === 503, String(status));
  ok("message points at the quote form", /quote form/i.test(out.error), out.error);
  ok("no Razorpay call", calls.razorpay.length === 0);
}

section("POST /api/orders — Razorpay rejects");
{
  const env = ENV();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { description: "Authentication failed" } }), { status: 401 });
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup", customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("502 to the client", status === 502);
  ok("razorpay's wording is not echoed", !/Authentication/i.test(out.error), out.error);
  ok("no order row on failure", env.DB._db.orders.length === 0);
}

// ── callback verification ─────────────────────────────────────────
section("POST /api/orders/verify");
{
  const env = ENV(); stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup", customer: CUSTOMER };
  await createOrderHandler(post(body), env, body);
  const rzpOrderId = env.DB._db.orders[0].rzp_order_id;
  const paymentId = "pay_STUB1";
  const sig = await hmacHex(`${rzpOrderId}|${paymentId}`, KEY_SECRET);

  const vbody = { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig };
  const [status, out] = await readJson(await verifyOrderHandler(post(vbody), env, vbody));
  ok("200 for a valid signature", status === 200, JSON.stringify(out));
  ok("returns the receipt", out.receipt === env.DB._db.orders[0].receipt);
  ok("records the payment id", env.DB._db.orders[0].rzp_payment_id === paymentId);

  // THE key assertion: the browser's word does not mark an order paid.
  ok("status stays pending — the browser cannot mark it paid (invariant 4)",
     env.DB._db.orders[0].status === "pending", env.DB._db.orders[0].status);

  // A forged callback must be rejected.
  const bad = { ...vbody, razorpay_signature: sig.slice(0, -1) + "0" };
  const [bstatus] = await readJson(await verifyOrderHandler(post(bad), env, bad));
  ok("400 for a forged signature", bstatus === 400);

  // Signed with the wrong secret.
  const wrong = { ...vbody, razorpay_signature: await hmacHex(`${rzpOrderId}|${paymentId}`, WEBHOOK_SECRET) };
  const [wstatus] = await readJson(await verifyOrderHandler(post(wrong), env, wrong));
  ok("400 when signed with WEBHOOK_SECRET", wstatus === 400);

  for (const [label, b] of [
    ["missing signature", { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId }],
    ["missing order id", { razorpay_payment_id: paymentId, razorpay_signature: sig }],
    ["missing payment id", { razorpay_order_id: rzpOrderId, razorpay_signature: sig }],
    ["empty body", {}],
  ]) {
    const [s] = await readJson(await verifyOrderHandler(post(b), env, b));
    ok(`${label} → 400`, s === 400);
  }
}

// ── webhook ───────────────────────────────────────────────────────
const webhookReq = (raw, sig, eventId) => new Request("http://x/api/webhook/razorpay", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-razorpay-signature": sig,
    ...(eventId ? { "x-razorpay-event-id": eventId } : {}),
  },
  body: raw,
});

async function seedPaidOrder() {
  const env = ENV(); const calls = stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 2 }], delivery: "ship", customer: CUSTOMER };
  await createOrderHandler(post(body), env, body);
  const o = env.DB._db.orders[0];
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: o.rzp_order_id } }, payment: { entity: { id: "pay_WH1", order_id: o.rzp_order_id } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  return { env, calls, order: o, raw, sig };
}

section("POST /api/webhook/razorpay — order.paid");
{
  const { env, calls, order, raw, sig } = await seedPaidOrder();
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_1"), env, ctx);
  await settle(ctx);

  ok("200", res.status === 200);
  ok("order marked paid (invariant 4)", env.DB._db.orders[0].status === "paid");
  ok("paid_at set", typeof env.DB._db.orders[0].paid_at === "number");
  ok("payment id recorded", env.DB._db.orders[0].rzp_payment_id === "pay_WH1");
  ok("two emails sent", calls.resend.length === 2, String(calls.resend.length));

  const to = calls.resend.map((e) => e.to[0]).sort();
  ok("customer emailed", to.includes("buyer@example.com"));
  ok("owner emailed", to.includes("owner@example.com"));
  const cust = calls.resend.find((e) => e.to[0] === "buyer@example.com");
  ok("customer email shows the receipt", cust.html.includes(order.receipt));
  ok("no secret in any email", !JSON.stringify(calls.resend).includes(KEY_SECRET));
}

section("webhook — signature is enforced");
{
  const { env, raw } = await seedPaidOrder();
  const ctx = makeCtx();

  const res = await razorpayWebhook(webhookReq(raw, "deadbeef", "evt_x"), env, ctx);
  ok("400 on a bad signature", res.status === 400);
  ok("order untouched", env.DB._db.orders[0].status === "pending");

  const res2 = await razorpayWebhook(webhookReq(raw, "", "evt_y"), env, ctx);
  ok("400 with no signature", res2.status === 400);

  // Signed with KEY_SECRET rather than WEBHOOK_SECRET.
  const wrong = await hmacHex(raw, KEY_SECRET);
  const res3 = await razorpayWebhook(webhookReq(raw, wrong, "evt_z"), env, ctx);
  ok("400 when signed with KEY_SECRET", res3.status === 400);
  ok("still pending after all three", env.DB._db.orders[0].status === "pending");
}

section("webhook — raw body, not re-serialised (invariant 3)");
{
  const { env, order } = await seedPaidOrder();
  const ctx = makeCtx();
  // Pretty-printed body, signed as pretty-printed: must verify, because the
  // handler HMACs exactly what arrived.
  const pretty = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } }, payment: { entity: { id: "pay_P", order_id: order.rzp_order_id } } },
  }, null, 2);
  const sigPretty = await hmacHex(pretty, WEBHOOK_SECRET);
  const res = await razorpayWebhook(webhookReq(pretty, sigPretty, "evt_pretty"), env, ctx);
  await settle(ctx);
  ok("whitespace-bearing body verifies against its own signature", res.status === 200);
  ok("and is processed", env.DB._db.orders[0].status === "paid");
}
{
  const { env, order } = await seedPaidOrder();
  const ctx = makeCtx();
  // Signature computed over the COMPACT form but body sent pretty-printed.
  const compact = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } } },
  });
  const pretty = JSON.stringify(JSON.parse(compact), null, 2);
  const sigCompact = await hmacHex(compact, WEBHOOK_SECRET);
  const res = await razorpayWebhook(webhookReq(pretty, sigCompact, "evt_mismatch"), env, ctx);
  ok("mismatched body/signature rejected", res.status === 400);
  ok("order untouched", env.DB._db.orders[0].status === "pending");
}

section("webhook — idempotency (invariant 5)");
{
  const { env, calls, raw, sig } = await seedPaidOrder();
  const ctx = makeCtx();

  await razorpayWebhook(webhookReq(raw, sig, "evt_dup"), env, ctx);
  await settle(ctx);
  const after1 = calls.resend.length;

  const res2 = await razorpayWebhook(webhookReq(raw, sig, "evt_dup"), env, ctx);
  await settle(ctx);

  ok("redelivery returns 200", res2.status === 200);
  ok("redelivery flagged as duplicate", (await res2.json()).duplicate === true);
  ok("still exactly 2 emails", calls.resend.length === after1 && after1 === 2, String(calls.resend.length));
  ok("one webhook_events row", env.DB._db.webhook_events.length === 1);
  ok("order still paid once", env.DB._db.orders[0].status === "paid");
}

section("webhook — a new event id still can't double-pay");
{
  const { env, calls, raw, sig } = await seedPaidOrder();
  const ctx = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_a"), env, ctx);
  await settle(ctx);
  // Same order, different event id — the status guard must stop it.
  await razorpayWebhook(webhookReq(raw, sig, "evt_b"), env, ctx);
  await settle(ctx);
  ok("emails not duplicated by a fresh event id", calls.resend.length === 2, String(calls.resend.length));
}

section("webhook — payment.failed does not kill the order");
{
  const { env, order } = await seedPaidOrder();
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_F", order_id: order.rzp_order_id, error_description: "declined" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_fail"), env, ctx);
  ok("200", res.status === 200);
  ok("order stays pending, not failed", env.DB._db.orders[0].status === "pending");
}

section("webhook — misconfiguration fails closed");
{
  const { env, raw, sig } = await seedPaidOrder();
  env.RAZORPAY_WEBHOOK_SECRET = "";
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_nosecret"), env, makeCtx());
  ok("503 when WEBHOOK_SECRET is unset", res.status === 503);
  ok("order untouched", env.DB._db.orders[0].status === "pending");
}

// ── receipt read ──────────────────────────────────────────────────
section("GET /api/orders/:receipt");
{
  const { env, order, raw, sig } = await seedPaidOrder();
  const ctx = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_r"), env, ctx);
  await settle(ctx);

  const [status, out] = await readJson(await getOrderHandler(env, order.receipt));
  ok("200", status === 200);
  ok("returns the order", out.order.receipt === order.receipt);
  ok("shows paid", out.order.status === "paid");
  ok("returns line items", out.items.length === 1);
  ok("does NOT expose the customer email", out.order.cust_email === undefined);
  ok("does NOT expose the address", out.order.addr_line === undefined);
  ok("does NOT expose the payment id", out.order.rzp_payment_id === undefined);

  const [nf] = await readJson(await getOrderHandler(env, "AP-00000000"));
  ok("unknown receipt → 404", nf === 404);
  for (const bad of ["", "nope", "AP-xyz", "AP-1234567", "' OR 1=1 --"]) {
    const [s] = await readJson(await getOrderHandler(env, bad));
    ok(`malformed receipt ${JSON.stringify(bad)} → 404`, s === 404);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
