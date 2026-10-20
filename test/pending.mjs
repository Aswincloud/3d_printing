// Unpaid-order follow-up: owner emails on checkout start and on a failed
// payment, the /o/<token> Complete-payment page, and the owner-pressed WhatsApp
// reminder. Nothing here may claim money arrived, and the pay page must never
// let the page decide what is charged.
//   node test/pending.mjs
import { notifyPendingCheckout, notifyFailedPayment } from "../src/orders.js";
import { payPendingPage } from "../src/paypending.js";
import { remindPayment } from "../src/admin.js";
import { pendingCheckoutOwnerEmail } from "../src/emails.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? " — " + d : ""}`); } };
const section = (s) => console.log(`\n${s}`);
const TOKEN = "0123456789abcdef0123456789abcdef";
const ORDER = (o = {}) => ({ id: "o-1", receipt: "AP-534abe47", status: "pending", rzp_order_id: "order_X", total_paise: 79800, shipping_paise: 9900,
  cust_name: "PSN sankar", cust_email: "s@example.com", cust_phone: "9876543210", addr_city: "Tirunelveli", addr_state: "Tamil Nadu", pay_token: TOKEN, pay_reminder_at: null, ...o });

function envWith(order, over = {}) {
  const db = { orders: order ? [{ ...order }] : [], items: [{ order_id: "o-1", name: "Ayyappan 1ft Gold Idol", qty: 1, price_paise: 69900, pos: 0 }] };
  const out = { mail: [], invoicer: [] };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT * FROM orders WHERE rzp_order_id = ?")) return { first: db.orders.find((o) => o.rzp_order_id === a[0]) || null };
    if (s.startsWith("SELECT name, qty FROM order_items")) return { results: db.items.filter((i) => i.order_id === a[0]) };
    if (s.startsWith("SELECT name, qty, price_paise FROM order_items")) return { results: db.items.filter((i) => i.order_id === a[0]) };
    if (s.startsWith("SELECT id, receipt, status, rzp_order_id, total_paise, shipping_paise")) return { first: db.orders.find((o) => o.pay_token === a[0]) || null };
    if (s.startsWith("SELECT id, receipt, status, total_paise, cust_name, cust_phone, pay_token FROM orders WHERE id = ?")) { const o = db.orders.find((x) => x.id === a[0]); return { first: o ? { ...o } : null }; }
    if (s.startsWith("UPDATE orders SET pay_token = ?")) { const o = db.orders.find((x) => x.id === a[1]); if (o && !o.pay_token) o.pay_token = a[0]; return { meta: { changes: 1 } }; }
    if (s.startsWith("SELECT pay_token FROM orders WHERE id = ?")) return { first: { pay_token: db.orders.find((x) => x.id === a[0])?.pay_token } };
    if (s.startsWith("UPDATE orders SET pay_reminder_at = ?")) { const o = db.orders.find((x) => x.id === a[1]); o.pay_reminder_at = a[0]; return { meta: { changes: 1 } }; }
    throw new Error("unhandled SQL: " + s.slice(0, 100));
  };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === "api.resend.com") { out.mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}'); }
    if (u.pathname === "/api/ingest/payment-reminder") { out.invoicer.push({ body: JSON.parse(init.body), sig: init.headers["x-shop-signature"], raw: init.body, redirect: init.redirect }); return new Response(JSON.stringify(over._invoicerReply || { ok: true, whatsapp: "sent" }), { status: over._invoicerStatus || 200 }); }
    throw new Error("unexpected " + url);
  };
  return { OWNER_EMAIL: "owner@example.com", RESEND_API_KEY: "re_x", APP_BASE_URL: "https://shop.test", RAZORPAY_KEY_ID: "rzp_test_PUBLIC",
    INVOICE_ENABLED: "true", INVOICER_URL: "https://inv.test", SHOP_INGEST_SECRET: "s3cret", ...over, _db: db, _out: out,
    DB: { prepare(sql) { const make = (a) => ({ bind: (...x) => make(x), async first() { return run(sql, a).first ?? null; }, async all() { return { results: run(sql, a).results || [] }; }, async run() { return run(sql, a); } }); return make([]); } } };
}

section("owner email: checkout started");
{
  const env = envWith(null);
  await notifyPendingCheckout(env, ORDER(), [{ name: "Ayyappan 1ft Gold Idol", qty: 1 }]);
  const m = env._out.mail[0];
  ok("one email to the owner", env._out.mail.length === 1 && JSON.stringify(m.to).includes("owner@example.com"));
  ok("subject says NOT paid, with receipt, amount, name", /^Checkout started: AP-534abe47 · ₹798 · PSN sankar$/.test(m.subject), m.subject);
  ok("body has items, phone, email, city", ["Ayyappan 1ft Gold Idol × 1", "9876543210", "s@example.com", "Tirunelveli, Tamil Nadu"].every((x) => m.text.includes(x)), m.text);
  ok("and their payment link", m.text.includes(`https://shop.test/o/${TOKEN}`));
  ok("never says paid or received", !/\bpaid\b(?! yet)|received/i.test(m.subject) && /not paid yet/i.test(m.text));
}
{ const env = envWith(null, { RESEND_API_KEY: "" }); await notifyPendingCheckout(env, ORDER(), []); ok("no Resend key: nothing sent, no crash", env._out.mail.length === 0); }

section("owner email: payment failed");
{
  const env = envWith(ORDER());
  await notifyFailedPayment(env, { order_id: "order_X", error_description: "Your payment could not be completed", method: "wallet", wallet: "mobikwik" });
  const m = env._out.mail[0];
  ok("emailed with Razorpay's reason and method", env._out.mail.length === 1 && /^Payment failed: AP-534abe47/.test(m.subject) && m.text.includes("could not be completed") && m.text.includes("wallet mobikwik"), m?.text);
}
{ const env = envWith(ORDER({ status: "paid" })); await notifyFailedPayment(env, { order_id: "order_X", error_description: "x" }); ok("already paid on a retry: no failed email", env._out.mail.length === 0); }
{ const env = envWith(ORDER()); await notifyFailedPayment(env, { order_id: "order_OTHER" }); ok("not a shop order (quote link, /pay): no email", env._out.mail.length === 0); }
{ const env = envWith(ORDER()); await notifyFailedPayment(env, {}); ok("no order id: no email", env._out.mail.length === 0); }
ok("template escapes the customer name", pendingCheckoutOwnerEmail({}, ORDER({ cust_name: "<b>x</b>" }), []).html.includes("&lt;b&gt;x&lt;/b&gt;"));

section("/o/<token>: the Complete-payment page");
{
  const env = envWith(ORDER());
  const r = await payPendingPage(env, TOKEN); const html = await r.text();
  ok("200, never cached, not indexed", r.status === 200 && r.headers.get("cache-control") === "no-store" && /noindex/.test(r.headers.get("x-robots-tag")));
  ok("shows items, shipping and total", html.includes("Ayyappan 1ft Gold Idol × 1") && html.includes("Shipping") && html.includes("Pay ₹798"));
  const cfg = JSON.parse(html.match(/data-cfg="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  ok("checkout uses the order's OWN Razorpay order and amount", cfg.order_id === "order_X" && cfg.amount === 79800 && cfg.key === "rzp_test_PUBLIC", JSON.stringify(cfg));
  ok("no inline script (CSP)", !/<script>(?!<\/script>)/.test(html) && html.includes('src="/assets/js/paypending.js"'));
  ok("the secret key is never on the page", !html.includes("KEY_SECRET") && !html.includes("s3cret"));
}
for (const [st, rx] of [["paid", /already paid/], ["delivered", /already paid/], ["cancelled", /cancelled/], ["refunded", /refunded/]]) {
  const html = await (await payPendingPage(envWith(ORDER({ status: st })), TOKEN)).text();
  ok(`${st}: says so, no pay button`, rx.test(html) && !html.includes('id="pay"'));
}
ok("unknown token: 404", (await payPendingPage(envWith(ORDER()), "f".repeat(32))).status === 404);
ok("malformed token: 404 without a query", (await payPendingPage(envWith(ORDER()), "../etc")).status === 404);
ok("no Razorpay key: no pay button", !(await (await payPendingPage(envWith(ORDER(), { RAZORPAY_KEY_ID: "" }), TOKEN)).text()).includes('id="pay"'));

section("Send payment reminder (owner-pressed)");
{
  const env = envWith(ORDER());
  const r = await remindPayment(env, "o-1"); const b = await r.json();
  const call = env._out.invoicer[0];
  ok("asks the invoicer once, signed", r.status === 200 && env._out.invoicer.length === 1 && call.sig === await hmacHex(call.raw, "s3cret"), JSON.stringify(b));
  ok("sends receipt, name, phone, amount and the pay token", call.body.receipt === "AP-534abe47" && call.body.phone === "9876543210" && call.body.amount_paise === 79800 && call.body.pay_token === TOKEN);
  ok("never follows a redirect", call.redirect === "error");
  ok("records when it was sent", env._db.orders[0].pay_reminder_at > 0);
  ok("returns the customer's link", b.link === `https://shop.test/o/${TOKEN}`);
}
{
  const env = envWith(ORDER({ pay_token: null }));
  const b = await (await remindPayment(env, "o-1")).json();
  ok("an older order with no link gets one minted", /^[0-9a-f]{32}$/.test(env._db.orders[0].pay_token) && b.link.endsWith(env._db.orders[0].pay_token));
}
for (const st of ["paid", "shipped", "cancelled"]) {
  const env = envWith(ORDER({ status: st }));
  const r = await remindPayment(env, "o-1");
  ok(`${st} order: refused, nothing sent`, r.status === 409 && env._out.invoicer.length === 0);
}
{ const env = envWith(ORDER({ cust_phone: "" })); ok("no phone: refused", (await remindPayment(env, "o-1")).status === 400 && env._out.invoicer.length === 0); }
{ const env = envWith(ORDER(), { _invoicerReply: { ok: true, whatsapp: "failed", why: "template not approved" } });
  const r = await remindPayment(env, "o-1"); const b = await r.json();
  ok("WhatsApp failure is reported, not recorded as sent", r.status === 502 && /template not approved/.test(b.error) && !env._db.orders[0].pay_reminder_at, JSON.stringify(b)); }
{ const env = envWith(ORDER(), { INVOICE_ENABLED: "false" }); ok("WhatsApp off: refused with a reason", (await remindPayment(env, "o-1")).status === 502 && env._out.invoicer.length === 0); }
ok("unknown order: 404", (await remindPayment(envWith(ORDER()), "nope")).status === 404);

console.log(`\n  pending: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
