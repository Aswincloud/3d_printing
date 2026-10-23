// /thank-you?t=<pay_token> — the page a customer lands on after paying (2026-10-23).
//
// It exists so Google Ads can count a purchase by URL: Ads asks for the address
// of the page shown after a successful purchase, and until now the receipt was a
// popup on the homepage, whose URL never changed.
//
// The page is only reached by the shop's own redirect after Razorpay's signed
// callback has verified (verifyOrderHandler), and it carries the order's private
// pay_token — 32 hex, never derived from the receipt — so a stranger cannot open
// someone else's thank-you page, and guessing one is hopeless. Without a valid
// token, or for an order that was never paid, it says so plainly and is noindex.
//
// The order is shown from the database, never from the URL: the amount on the
// page is what was actually recorded.
import { esc, rupeesText } from "./pagebits.js";

const TOKEN_RE = /^[0-9a-f]{32}$/;
const PAID = new Set(["paid", "in_production", "ready", "shipped", "delivered"]);

export async function thankYouPage(env, url) {
  const token = String(url.searchParams.get("t") || "");
  if (!TOKEN_RE.test(token)) return page("Thank you", `<h1>Thank you</h1><p>Your order details are in your email. <a href="/">Back to the shop</a></p>`);

  const o = await env.DB.prepare(
    `SELECT id, receipt, status, total_paise, shipping_paise, discount_paise, coupon_code, cust_name, rzp_payment_id
       FROM orders WHERE pay_token = ?`).bind(token).first();
  if (!o) return page("Thank you", `<h1>Thank you</h1><p>Your order details are in your email. <a href="/">Back to the shop</a></p>`);

  const { results } = await env.DB.prepare(
    `SELECT name, qty, price_paise FROM order_items WHERE order_id = ? ORDER BY pos`).bind(o.id).all();
  const items = results || [];
  const rows = items.map((it) => `<tr><td>${esc(it.name)} × ${it.qty}</td><td class="r">${rupeesText(it.price_paise * it.qty)}</td></tr>`).join("") +
    (o.discount_paise > 0 ? `<tr><td>Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ""}</td><td class="r">−${rupeesText(o.discount_paise)}</td></tr>` : "") +
    `<tr><td>Shipping</td><td class="r">${o.shipping_paise ? rupeesText(o.shipping_paise) : "Free"}</td></tr>` +
    `<tr class="t"><td>Total</td><td class="r">${rupeesText(o.total_paise)}</td></tr>`;

  // The webhook marks an order paid a moment after the browser gets here, so a
  // just-verified payment (rzp_payment_id recorded by verifyOrderHandler) reads as
  // received too. An order with neither was never paid: no thank-you for that.
  const received = PAID.has(o.status) || (o.status === "pending" && o.rzp_payment_id);
  if (!received) {
    return page(`Order ${o.receipt}`, `<h1>Payment not completed</h1>
      <p>Order <strong>${esc(o.receipt)}</strong> hasn't been paid yet.</p>
      <p><a class="btn" href="/o/${esc(token)}">Complete payment</a></p>`);
  }
  const name = String(o.cust_name || "").trim().split(/\s+/)[0] || "";
  return page("Thank you for your order", `
    <p class="tick" aria-hidden="true">✓</p>
    <h1>Thank you${name ? ", " + esc(name) : ""}!</h1>
    <p class="sub">Your payment is received and order <strong>${esc(o.receipt)}</strong> is confirmed.</p>
    <table>${rows}</table>
    <p>You'll get a confirmation by email and WhatsApp, and another message when it ships with a tracking number.</p>
    <p class="links"><a class="btn" href="/#orders">Track my order</a> <a href="/#shop">Continue shopping</a></p>`);
}

function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — AswinPrints</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b10; color:#f4f4f5; font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  main { max-width:480px; margin:0 auto; padding:40px 16px 56px; }
  .tick { width:56px; height:56px; margin:0 0 12px; border-radius:50%; background:#16a34a; color:#fff; font-size:30px; line-height:56px; text-align:center; }
  h1 { font-size:1.6rem; margin:0 0 6px; } .sub { color:#a1a1aa; margin:0 0 20px; }
  table { width:100%; border-collapse:collapse; margin:0 0 18px; font-size:15px; }
  td { padding:9px 0; border-bottom:1px solid rgba(255,255,255,.08); } td.r { text-align:right; }
  tr.t td { font-weight:700; border-bottom:0; font-size:17px; }
  .links { display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-top:22px; }
  .btn { display:inline-block; min-height:44px; line-height:44px; padding:0 20px; font-weight:700; color:#111; background:#ff6b00; border-radius:12px; text-decoration:none; }
  a { color:#ff8c38; } p { line-height:1.55; }
</style></head><body><main>${body}</main></body></html>`,
    // no-store and no referrer: the token is in the URL and must not travel or be cached.
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
}
