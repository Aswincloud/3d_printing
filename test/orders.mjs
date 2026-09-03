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
// Distinct from the two above on purpose: the shop now holds three secrets that
// sign three different things, and a test that reused one would not notice if
// the code signed an invoice with the Razorpay key.
const INGEST_SECRET = "test_ingest_secret_value";

const PRODUCTS = [
  { id: "p-small", name: "Kingfisher", price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant", price_paise: 89900, visible: 1 },
  { id: "p-hidden", name: "Spider-Man", price_paise: 54900, visible: 0 },
  { id: "p-name", name: "Plate Keychain", price_paise: 29900, visible: 1,
    personalise_label: "Name or text to print", personalise_required: 1 },
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
  const db = { products: [...PRODUCTS], orders: [], order_items: [], webhook_events: [],
               coupons: [{ id: "c-1", code: "CHAT-ABC123", uses: 0 }], coupon_redemptions: [],
               quotes: [] };

  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT * FROM quotes WHERE receipt")) {
      return { first: db.quotes.find((q) => q.receipt === args[0]) || null };
    }
    if (s.startsWith("UPDATE quotes SET status = 'paid'")) {
      // The conditional claim. `AND order_id IS NULL` is what makes a second
      // delivery a no-op, so the fake has to honour it or the race test below
      // passes for the wrong reason.
      const q = db.quotes.find((x) => x.id === args[2]);
      if (!q || (s.includes("order_id IS NULL") && q.order_id)) return { meta: { changes: 0 } };
      q.status = "paid"; q.order_id = args[0]; q.updated_at = args[1];
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE quotes SET status = ?, order_id = NULL")) {
      const q = db.quotes.find((x) => x.id === args[2] && x.order_id === args[3]);
      if (!q) return { meta: { changes: 0 } };
      q.status = args[0]; q.order_id = null; q.updated_at = args[1];
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("SELECT * FROM orders WHERE id = ?")) {
      return { first: db.orders.find((o) => o.id === args[0]) || null };
    }
    if (s.startsWith("INSERT INTO orders (id, receipt, rzp_order_id, rzp_payment_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery, cust_name, cust_email, cust_phone, notes, created_at, paid_at)")) {
      const [id, receipt, rzp_order_id, rzp_payment_id, subtotal_paise, total_paise,
             cust_name, cust_email, cust_phone, notes, created_at, paid_at] = args;
      db.orders.push({ id, receipt, rzp_order_id, rzp_payment_id, status: "paid",
        subtotal_paise, shipping_paise: 0, total_paise, currency: "INR", delivery: "ship",
        cust_name, cust_email, cust_phone, addr_line: "", addr_city: "", addr_state: "",
        addr_pin: "", notes, created_at, paid_at, shipped_at: null });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("SELECT id, name, price_paise, personalise_label, personalise_required FROM products")) {
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
    if (s.startsWith("INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, personalisation, pos) VALUES (?,?,NULL,")) {
      // The quotation line: product_id is inlined as NULL because it never came
      // from the catalogue, so only five values are bound.
      const [id, order_id, name, price_paise, personalisation] = args;
      db.order_items.push({ id, order_id, product_id: null, name, price_paise,
                            qty: 1, personalisation, pos: 0 });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO order_items")) {
      const [id, order_id, product_id, name, price_paise, qty, personalisation, pos] = args;
      db.order_items.push({ id, order_id, product_id, name, price_paise, qty,
                            personalisation, pos });
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
    if (s.startsWith("SELECT name, price_paise, qty, personalisation FROM order_items WHERE order_id = (SELECT id FROM orders WHERE receipt")) {
      const o = db.orders.find((x) => x.receipt === args[0]);
      const rows = o ? db.order_items.filter((i) => i.order_id === o.id).sort((a, b) => a.pos - b.pos) : [];
      return { results: rows.map((r) => project(r, ["name", "price_paise", "qty"])) };
    }
    if (s.startsWith("SELECT name, price_paise, qty, personalisation FROM order_items WHERE order_id")) {
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
    // The coupon redemption path, reached when a paid order carries a code.
    // Minimal on purpose — test/coupons.mjs owns the redemption logic; this fake
    // only has to let handleOrderPaid() get past it to the invoicing that this
    // file is testing.
    if (s.startsWith("SELECT id FROM coupons WHERE code = ?")) {
      const c = db.coupons?.find((x) => x.code.toUpperCase() === String(args[0]).toUpperCase());
      return { first: c ? { id: c.id } : null };
    }
    if (s.startsWith("INSERT OR IGNORE INTO coupon_redemptions")) {
      db.coupon_redemptions = db.coupon_redemptions || [];
      if (db.coupon_redemptions.some((r) => r.order_id === args[2])) return { meta: { changes: 0 } };
      db.coupon_redemptions.push({ id: args[0], coupon_id: args[1], order_id: args[2] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE coupons SET uses = uses + 1")) {
      const c = db.coupons?.find((x) => x.id === args[1]);
      if (c) c.uses = (c.uses || 0) + 1;
      return { meta: { changes: c ? 1 : 0 } };
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
  FREE_SHIP_THRESHOLD_PAISE: "200000",
  INVOICE_ENABLED: "true",
  INVOICER_URL: "https://invoicer.example",
  SHOP_INGEST_SECRET: INGEST_SECRET,
  DB: makeDB(),
});

const CUSTOMER = {
  name: "Test Buyer", email: "buyer@example.com", phone: "9876543210",
  addr_line: "12 Main Street", addr_city: "Pondicherry",
  addr_state: "Puducherry", addr_pin: "605001",
};

// Stub Razorpay + Resend at the fetch boundary; record what each is sent.
function stubFetch({ invoicerStatus = 200, invoicerBody = null } = {}) {
  const calls = { razorpay: [], resend: [], invoicer: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/api/ingest/order")) {
      calls.invoicer.push({
        url: u,
        body: JSON.parse(init.body || "{}"),
        signature: init.headers?.["x-shop-signature"] || "",
        raw: init.body,
      });
      return new Response(
        JSON.stringify(invoicerBody ?? { ok: true, id: "inv-1", number: "AP-2026-STUB", emailed: true }),
        { status: invoicerStatus, headers: { "content-type": "application/json" } });
    }
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

// Pickup was withdrawn: every order ships. The handler hardcodes delivery rather
// than reading it from the body, because shippingFor() used to return 0 for
// pickup — so while that field was honoured, a client could post
// {delivery:"pickup"} and pay nothing for shipping. Same class of bug as sending
// your own price, and removing the radio from the form would not have closed it.
section("POST /api/orders — the client cannot waive shipping");
{
  const env = ENV(); stubFetch();
  const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: "pickup", customer: CUSTOMER };
  const [, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("a pickup claim is still charged shipping", out.shipping_paise === 9900, String(out.shipping_paise));
  ok("total includes shipping", out.total_paise === 44800, String(out.total_paise));
  ok("the address is stored, not discarded", env.DB._db.orders[0].addr_line === CUSTOMER.addr_line);
  ok("delivery is recorded as ship", env.DB._db.orders[0].delivery === "ship", env.DB._db.orders[0].delivery);
}
{
  // Every spelling and type, so a future refactor cannot reintroduce the branch
  // through a case difference or a truthy value.
  for (const mode of ["pickup", "PICKUP", "Pickup", "collect", true, 1, {}]) {
    const env = ENV(); stubFetch();
    const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: mode, customer: CUSTOMER };
    const [, out] = await readJson(await createOrderHandler(post(body), env, body));
    ok(`delivery=${JSON.stringify(mode)} → shipping charged`, out.shipping_paise === 9900);
  }
}
{
  const env = ENV(); stubFetch();
  // 3 × 89900 = 269700, which clears the ₹2,000 free-shipping threshold. This was
  // qty 2 (179800) when the threshold was ₹1,500.
  const body = { items: [{ product_id: "p-large", qty: 3 }], delivery: "ship", customer: CUSTOMER };
  const [, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("over threshold ships free", out.shipping_paise === 0);
  ok("total = 269700 with no shipping added", out.total_paise === 269700, String(out.total_paise));
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

section("POST /api/orders — an address is always required");
{
  // This used to assert the opposite ("pickup without an address is accepted").
  // With pickup withdrawn there is no way to place an order without one, so a
  // request that omits the address must fail however it labels its delivery.
  for (const mode of ["pickup", "ship", undefined]) {
    const env = ENV(); const calls = stubFetch();
    const body = { items: [{ product_id: "p-small", qty: 1 }], delivery: mode,
      customer: { name: "A B", email: "a@b.com", phone: "9876543210" } };
    const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
    ok(`delivery=${JSON.stringify(mode)} without an address → 400`, status === 400, String(status));
    ok(`delivery=${JSON.stringify(mode)} asks for the address`,
       /street address/i.test(out.error || ""), out.error);
    ok(`delivery=${JSON.stringify(mode)} makes no Razorpay call`, calls.razorpay.length === 0);
  }
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

// A 401 from Razorpay means the keys are wrong or expired. It CANNOT be fixed by
// retrying, so the customer must not be told to try again in a moment — that wastes
// their time and loses the sale with no trace. 503 + the quote form, matching how
// unset keys are already handled. This happened for real: the configured test key
// expired and every checkout returned "please try again in a moment".
section("POST /api/orders — Razorpay rejects the keys (401)");
for (const desc of ["Authentication failed",
                    "The api key provided by you has expired and cannot be used."]) {
  const env = ENV();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { description: desc } }), { status: 401 });
  const body = { items: [{ product_id: "p-small", qty: 1 }], customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok(`503, not 502, for "${desc.slice(0, 24)}…"`, status === 503, String(status));
  ok("does not promise that retrying will work", !/try again/i.test(out.error), out.error);
  ok("points at the quote form instead", /quote request/i.test(out.error), out.error);
  ok("razorpay's wording is not echoed to the customer",
     !/Authentication|api key/i.test(out.error), out.error);
  ok("no order row on failure", env.DB._db.orders.length === 0);
}
{
  // A non-401 upstream failure IS potentially transient, so that path keeps 502
  // and keeps suggesting a retry.
  const env = ENV();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { description: "Gateway timeout" } }), { status: 502 });
  const body = { items: [{ product_id: "p-small", qty: 1 }], customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("non-401 upstream failure stays 502", status === 502, String(status));
  ok("and does suggest retrying", /try again/i.test(out.error), out.error);
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
  // A second invoice means a second invoice email and a duplicate document in
  // the books. Invoicer has its own UNIQUE index, but the shop must not be
  // relying on that — this asserts the shop's own guard.
  ok("invoicer called exactly once", calls.invoicer.length === 1, String(calls.invoicer.length));
}

// ── invoicing ─────────────────────────────────────────────────────
//
// The shop asks invoicer.aswincloud.com to raise a real invoice. What matters
// here is (a) it happens exactly once per payment, (b) the numbers handed over
// are the ones actually charged, and (c) it can NEVER break the webhook — the
// money has already moved by the time this runs.
section("webhook — invoicing");
{
  const { env, calls, order } = await seedPaidOrder();
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV1" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  await razorpayWebhook(webhookReq(raw, sig, "evt_inv"), env, ctx);
  await settle(ctx);

  ok("invoicer called once", calls.invoicer.length === 1, String(calls.invoicer.length));
  const sent = calls.invoicer[0];
  ok("posted to the ingest endpoint", /\/api\/ingest\/order$/.test(sent.url), sent.url);
  ok("signed", /^[0-9a-f]{64}$/.test(sent.signature), sent.signature.slice(0, 20));

  // Signed with the INGEST secret, not one of the Razorpay ones. Three secrets
  // now sign three different things; using the wrong one would authenticate
  // nothing and be invisible without this check.
  const expect = await hmacHex(sent.raw, INGEST_SECRET);
  ok("signed with the ingest secret", sent.signature === expect);
  ok("NOT signed with the razorpay key", sent.signature !== await hmacHex(sent.raw, KEY_SECRET));

  // THE numbers. These end up on a document the customer keeps, next to a bank
  // statement showing what was actually taken.
  ok("receipt sent", sent.body.receipt === order.receipt, sent.body.receipt);
  ok("total is the amount charged", sent.body.total_paise === order.total_paise,
     `${sent.body.total_paise} vs ${order.total_paise}`);
  ok("subtotal sent", sent.body.subtotal_paise === order.subtotal_paise);
  ok("shipping sent", sent.body.shipping_paise === order.shipping_paise);
  ok("amounts are integer paise, never floats",
     Number.isInteger(sent.body.total_paise) && Number.isInteger(sent.body.subtotal_paise));
  ok("customer email sent", sent.body.customer.email === "buyer@example.com");
  ok("address sent", sent.body.customer.addr_pin === "605001");
  ok("items sent", sent.body.items.length > 0 && sent.body.items[0].price_paise > 0);
  ok("a timestamp is included", typeof sent.body.ts === "number");

  // No secret may travel in the body — it is only ever a signature header.
  const asText = JSON.stringify(sent.body);
  ok("no secrets in the payload",
     !asText.includes(INGEST_SECRET) && !asText.includes(KEY_SECRET) && !asText.includes(WEBHOOK_SECRET));
}
{
  // Invoicer down. The payment already succeeded — this must not fail the
  // webhook, because Razorpay would retry and a retry storm caused by an
  // INVOICING outage would be a self-inflicted incident on the payment path.
  const { env, calls, order } = await seedPaidOrder();
  stubFetch({ invoicerStatus: 500, invoicerBody: { error: "boom" } });
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV2" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_inv_fail"), env, ctx);
  let threw = false;
  try { await settle(ctx); } catch { threw = true; }

  ok("webhook still 200s when invoicing fails", res.status === 200, String(res.status));
  ok("nothing throws into the webhook", !threw);
  ok("the order is still marked paid", env.DB._db.orders[0].status === "paid");
}
{
  // Same, for a network-level failure rather than an HTTP error.
  const { env, order } = await seedPaidOrder();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/ingest/order")) throw new Error("ECONNREFUSED");
    if (String(url).includes("api.resend.com")) return new Response("{}", { status: 200 });
    throw new Error("unexpected fetch: " + url);
  };
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV3" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_inv_net"), env, ctx);
  let threw = false;
  try { await settle(ctx); } catch { threw = true; }

  ok("an unreachable invoicer does not break the webhook", res.status === 200 && !threw);
  ok("the order is still paid", env.DB._db.orders[0].status === "paid");
}
{
  // Kill switch: no call at all, and the rest of the webhook is unaffected.
  const { env, calls, order } = await seedPaidOrder();
  env.INVOICE_ENABLED = "false";
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV4" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  await razorpayWebhook(webhookReq(raw, sig, "evt_inv_off"), env, ctx);
  await settle(ctx);

  ok("disabled → invoicer not called", calls.invoicer.length === 0, String(calls.invoicer.length));
  ok("emails still sent", calls.resend.length === 2, String(calls.resend.length));
}
{
  // Missing secret must not send an UNSIGNED request — that would be rejected at
  // the far end anyway, but attempting it means the shop is willing to.
  const { env, calls, order } = await seedPaidOrder();
  env.SHOP_INGEST_SECRET = "";
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV5" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  await razorpayWebhook(webhookReq(raw, sig, "evt_inv_nosec"), env, ctx);
  await settle(ctx);
  ok("no secret → no request at all", calls.invoicer.length === 0, String(calls.invoicer.length));
}
{
  // A discounted order: the coupon code must reach the invoice, since it appears
  // on the document as a named line.
  const { env, calls, order } = await seedPaidOrder();
  env.DB._db.orders[0].discount_paise = 10000;
  env.DB._db.orders[0].coupon_code = "CHAT-ABC123";
  order.discount_paise = 10000;
  order.coupon_code = "CHAT-ABC123";
  const ctx = makeCtx();
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: order.rzp_order_id } },
               payment: { entity: { id: "pay_INV6" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  await razorpayWebhook(webhookReq(raw, sig, "evt_inv_disc"), env, ctx);
  await settle(ctx);

  const sent = calls.invoicer[0];
  ok("discount amount sent", sent.body.discount_paise === 10000, String(sent.body.discount_paise));
  ok("coupon code sent", sent.body.coupon_code === "CHAT-ABC123", String(sent.body.coupon_code));
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

// ── personalisation reaches the order and the emails ──────────────
//
// The end of the chain the feature exists for. An order for a personalised item
// is not actionable without this value, so it has to survive priceCart, the
// order_items insert, and the read that builds the owner's mail.
section("POST /api/orders — what to print is recorded and mailed");
{
  const env = ENV(); stubFetch();
  const body = {
    items: [{ product_id: "p-name", qty: 2, personalisation: "SUNNY" }],
    delivery: "ship", customer: CUSTOMER,
  };
  const [status] = await readJson(await createOrderHandler(post(body), env, body));
  ok("order created", status === 200);

  const row = env.DB._db.order_items[0];
  ok("stored on the line", row.personalisation === "SUNNY", JSON.stringify(row));
  // One value for the whole line, which is what makes the duplicate-collapse
  // safe to keep: both keychains say SUNNY.
  ok("one line, qty 2", env.DB._db.order_items.length === 1 && row.qty === 2);
}

section("POST /api/orders — a required value cannot be skipped through the API");
{
  const env = ENV(); stubFetch();
  // The browser disables the button, but the API is reachable without it and
  // Buy-now skips the cart entirely. This is the check that actually holds.
  const body = { items: [{ product_id: "p-name", qty: 1 }], delivery: "ship", customer: CUSTOMER };
  const [status, out] = await readJson(await createOrderHandler(post(body), env, body));
  ok("refused", status === 400, String(status));
  ok("names the product", /Plate Keychain/.test(out.error || ""), out.error);
  ok("no order was created", env.DB._db.orders.length === 0);
  ok("and no line either", env.DB._db.order_items.length === 0);
}

// ── payment_link.paid: a quotation becomes a real order ───────────
//
// Answering a quote from the dashboard mints a Razorpay payment link. This is
// where the money becomes an order with a receipt, emails and an invoice, rather
// than an amount that arrived attached to nothing.
const QUOTE_ROW = {
  id: "q-1", receipt: "QT-ABCD1234", status: "replied",
  cust_name: "Priya", cust_email: "priya@example.com", cust_phone: "9000090000",
  description: "A keychain with a name on it.", quoted_paise: 49900,
  rzp_plink_id: "plink_1", order_id: null,
};

const linkPaidBody = (ref = "QT-ABCD1234", amount = 49900) => JSON.stringify({
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { id: "plink_1", reference_id: ref, status: "paid" } },
    order: { entity: { id: "order_PL1", amount, amount_paid: amount, status: "paid" } },
    payment: { entity: { id: "pay_PL1", order_id: "order_PL1", status: "captured", amount } },
  },
});

section("POST /api/webhook/razorpay — payment_link.paid");
{
  const env = ENV(); const calls = stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = linkPaidBody();
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();

  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_pl_1"), env, ctx);
  await settle(ctx);

  ok("200", res.status === 200);
  const order = env.DB._db.orders[0];
  ok("an order was created", Boolean(order), JSON.stringify(env.DB._db.orders));
  ok("it is paid", order.status === "paid");
  ok("it has a receipt", /^AP-[0-9A-F]{8}$/.test(order.receipt), order.receipt);
  ok("razorpay ids recorded", order.rzp_order_id === "order_PL1" && order.rzp_payment_id === "pay_PL1");
  // What Razorpay says was PAID, never what we quoted - if those disagree the
  // order must record the money that actually moved.
  ok("total is the amount paid", order.total_paise === 49900, String(order.total_paise));
  ok("no shipping added to a quoted price", order.shipping_paise === 0);
  ok("names the quote in notes", /QT-ABCD1234/.test(order.notes), order.notes);
  // A quote request never asks for one; the dashboard flags it instead.
  ok("address is blank, as expected", order.addr_line === "");

  const line = env.DB._db.order_items[0];
  ok("one line item", env.DB._db.order_items.length === 1);
  ok("not a catalogue product", line.product_id === null || line.product_id === undefined);
  ok("line carries the quote", /QT-ABCD1234/.test(line.name), line.name);

  ok("the quote is marked paid", env.DB._db.quotes[0].status === "paid");
  ok("and linked to the order", env.DB._db.quotes[0].order_id === order.id);

  ok("customer and owner were emailed", calls.resend.length >= 2, String(calls.resend.length));
  ok("an invoice was raised", calls.invoicer.length === 1, String(calls.invoicer.length));
}

section("payment_link.paid — a redelivery does nothing twice");
{
  const env = ENV(); stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = linkPaidBody();
  const sig = await hmacHex(raw, WEBHOOK_SECRET);

  const c1 = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_pl_2"), env, c1); await settle(c1);
  // Same event id: stopped by the webhook_events primary key.
  const c2 = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_pl_2"), env, c2); await settle(c2);
  // DIFFERENT event id for the same link: stopped by quotes.order_id instead.
  const c3 = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_pl_3"), env, c3); await settle(c3);

  ok("exactly one order", env.DB._db.orders.length === 1, String(env.DB._db.orders.length));
  ok("exactly one line", env.DB._db.order_items.length === 1);
}

section("payment_link.paid — two deliveries with NO event id race for one quote");
{
  // No x-razorpay-event-id header at all, so webhook_events cannot help, and the
  // two deliveries interleave: both read the quote before either has written.
  // The conditional UPDATE is the only thing between this and two orders, two
  // receipts and two invoices for one payment.
  const env = ENV(); stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = linkPaidBody();
  const sig = await hmacHex(raw, WEBHOOK_SECRET);

  const c1 = makeCtx(), c2 = makeCtx();
  const noId = (r) => { const h = new Headers(r.headers); h.delete("x-razorpay-event-id"); return new Request(r.url, { method: "POST", headers: h, body: raw }); };
  await Promise.all([
    razorpayWebhook(noId(webhookReq(raw, sig, "")), env, c1),
    razorpayWebhook(noId(webhookReq(raw, sig, "")), env, c2),
  ]);
  await settle(c1); await settle(c2);

  ok("exactly one order despite the race", env.DB._db.orders.length === 1, String(env.DB._db.orders.length));
  ok("exactly one line", env.DB._db.order_items.length === 1);
  ok("the quote points at the order that exists",
     env.DB._db.quotes[0].order_id === env.DB._db.orders[0]?.id);
}

section("payment_link.paid — a failed order write releases the claim");
{
  const env = ENV(); stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = linkPaidBody();
  const sig = await hmacHex(raw, WEBHOOK_SECRET);

  // D1 falls over on the batch, once.
  const realBatch = env.DB.batch.bind(env.DB);
  let failed = false;
  env.DB.batch = async (stmts) => {
    if (!failed) { failed = true; throw new Error("D1 hiccup"); }
    return realBatch(stmts);
  };
  const c1 = makeCtx();
  let threw = false;
  try { await razorpayWebhook(webhookReq(raw, sig, "evt_pl_fail1"), env, c1); } catch { threw = true; }
  ok("the first delivery fails loudly so Razorpay retries", threw);
  ok("no order was written", env.DB._db.orders.length === 0);
  ok("the quote is NOT left marked paid", env.DB._db.quotes[0].status !== "paid" && env.DB._db.quotes[0].order_id == null,
     JSON.stringify(env.DB._db.quotes[0]));

  const c2 = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_pl_fail2"), env, c2); await settle(c2);
  ok("the retry converts the quote", env.DB._db.orders.length === 1 && env.DB._db.quotes[0].status === "paid");
}

section("payment_link.paid — an unknown reference is refused quietly");
{
  const env = ENV(); stubFetch();
  const raw = linkPaidBody("QT-NOSUCH");
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_pl_4"), env, ctx);
  await settle(ctx);
  // 200 so Razorpay stops retrying something we can never resolve.
  ok("200", res.status === 200);
  ok("no order invented", env.DB._db.orders.length === 0);
}

section("order.paid for a payment link is harmless");
{
  // Razorpay fires order.paid for this payment too, moments apart. It finds no
  // orders row for that rzp_order_id and must do nothing - if this branch ever
  // starts acting on payments it does not own, this is what catches it.
  const env = ENV(); stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = JSON.stringify({
    event: "order.paid",
    payload: { order: { entity: { id: "order_PL1" } },
               payment: { entity: { id: "pay_PL1", order_id: "order_PL1" } } },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_op_1"), env, ctx);
  await settle(ctx);
  ok("200", res.status === 200);
  ok("no order created by this path", env.DB._db.orders.length === 0);
  ok("the quote is untouched", env.DB._db.quotes[0].status === "replied");
}

// ── the alarm for a payment nobody can attribute ──────────────────
//
// The one webhook outcome that must never be quiet: money arrived, and no order,
// receipt, invoice or customer email was created for it. Before this the handler
// logged a line and returned 200, so Razorpay was told "handled" and the only
// trace was a console entry nobody reads.
//
// It doubles as the tripwire for a payload change. handleQuotePaid reads
// reference_id from a shape taken from Razorpay's docs rather than an observed
// event; if that shape is wrong in production, these are the branches that fire.
section("payment_link.paid — an unmatched payment raises the alarm");
{
  const env = ENV(); const calls = stubFetch();
  const raw = linkPaidBody("QT-NOSUCH", 49900);
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_alert_1"), env, ctx);
  await settle(ctx);

  // Still 200: Razorpay must stop retrying something we can never resolve.
  ok("200 to Razorpay", res.status === 200);
  ok("no order invented", env.DB._db.orders.length === 0);

  const mail = calls.resend[0];
  ok("the owner is emailed", Boolean(mail), String(calls.resend.length));
  ok("sent to the owner", JSON.stringify(mail.to).includes(ENV().OWNER_EMAIL),
     JSON.stringify(mail.to));
  // Everything needed to find the money in the Razorpay dashboard at 11pm.
  const blob = JSON.stringify(mail);
  ok("names the payment id", blob.includes("pay_PL1"));
  ok("names the payment link", blob.includes("plink_1"));
  ok("names the razorpay order", blob.includes("order_PL1"));
  ok("names the reference that failed", blob.includes("QT-NOSUCH"));
  ok("states the amount", /499/.test(blob), blob.slice(0, 0) || "amount missing");
}

section("payment_link.paid — no reference at all also raises it");
{
  const env = ENV(); const calls = stubFetch();
  // A link created outside this dashboard, or a payload whose shape moved.
  const raw = JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: "plink_ORPHAN", status: "paid", amount: 25000 } },
      order: { entity: { id: "order_O1", amount_paid: 25000 } },
      payment: { entity: { id: "pay_O1", order_id: "order_O1", amount: 25000 } },
    },
  });
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_alert_2"), env, ctx);
  await settle(ctx);

  ok("200", res.status === 200);
  ok("the owner is emailed", calls.resend.length === 1, String(calls.resend.length));
  ok("says there was no reference",
     /no reference/i.test(JSON.stringify(calls.resend[0])),
     String(calls.resend[0]?.subject));
}

section("payment_link.paid — a payment that DOES match raises no alarm");
{
  const env = ENV(); const calls = stubFetch();
  env.DB._db.quotes.push({ ...QUOTE_ROW });
  const raw = linkPaidBody();
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  await razorpayWebhook(webhookReq(raw, sig, "evt_alert_3"), env, ctx);
  await settle(ctx);

  ok("an order exists", env.DB._db.orders.length === 1);
  // Two mails go out for a good payment - customer receipt and owner
  // notification - and neither is the alarm.
  const alarms = calls.resend.filter((c) => /no order/i.test(String(c.subject || "")));
  ok("no alarm raised", alarms.length === 0, String(alarms.length));
}

section("the alarm cannot break the webhook");
{
  // A failing alert must not fail the response: Razorpay retries on non-200, so a
  // broken mailer would turn one unattributable payment into a retry storm.
  const env = ENV();
  globalThis.fetch = async () => { throw new Error("resend is down"); };
  const raw = linkPaidBody("QT-NOSUCH");
  const sig = await hmacHex(raw, WEBHOOK_SECRET);
  const ctx = makeCtx();
  const res = await razorpayWebhook(webhookReq(raw, sig, "evt_alert_4"), env, ctx);
  await settle(ctx);
  ok("still 200 when the mailer throws", res.status === 200, String(res.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
