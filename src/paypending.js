// /o/<pay_token> — finish paying a pending order (2026-10-20).
//
// For a customer who left checkout without paying. The page shows what they
// ordered and the total, and opens Razorpay Checkout for the SAME Razorpay order
// at the SAME amount: both are read from the row, so the page cannot change what
// is charged. Payment completes exactly as a normal checkout — the order.paid
// webhook marks it paid and sends the usual emails and WhatsApp.
//
// The token is the credential: 32 hex characters, minted per order, never derived
// from the receipt. A paid order says so; a cancelled one says it was cancelled.
import { esc, rupeesText } from "./pagebits.js";

const TOKEN_RE = /^[0-9a-f]{32}$/;

export async function payPendingPage(env, token) {
  if (!TOKEN_RE.test(String(token || ""))) return page("Not found", `<p>This payment link isn't valid.</p>`, 404);
  const o = await env.DB.prepare(
    `SELECT id, receipt, status, rzp_order_id, total_paise, shipping_paise, discount_paise, coupon_code,
            cust_name, cust_email, cust_phone
       FROM orders WHERE pay_token = ?`).bind(token).first();
  if (!o) return page("Not found", `<p>This payment link isn't valid.</p>`, 404);
  const { results } = await env.DB.prepare(
    `SELECT name, qty, price_paise FROM order_items WHERE order_id = ? ORDER BY pos`).bind(o.id).all();
  const items = results || [];
  const rows = items.map((it) => `<tr><td>${esc(it.name)} × ${it.qty}</td><td class="r">${rupeesText(it.price_paise * it.qty)}</td></tr>`).join("") +
    // The coupon, so the lines add up to the total the customer is asked to pay.
    (o.discount_paise > 0 ? `<tr><td>Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ""}</td><td class="r">−${rupeesText(o.discount_paise)}</td></tr>` : "") +
    (o.shipping_paise ? `<tr><td>Shipping</td><td class="r">${rupeesText(o.shipping_paise)}</td></tr>` : "") +
    `<tr class="t"><td>Total</td><td class="r">${rupeesText(o.total_paise)}</td></tr>`;

  if (o.status !== "pending") {
    const msg = o.status === "cancelled" || o.status === "failed"
      ? "This order was cancelled, so no payment is due."
      : o.status === "refunded" ? "This order was refunded." : "This order is already paid — thank you!";
    return page(`Order ${o.receipt}`, `<h1>Order ${esc(o.receipt)}</h1><p class="ok">${esc(msg)}</p><table>${rows}</table>
      <p><a href="/">Back to the shop</a></p>`);
  }
  const keyId = String(env.RAZORPAY_KEY_ID || "");
  if (!keyId || !o.rzp_order_id) return page(`Order ${o.receipt}`, `<h1>Order ${esc(o.receipt)}</h1><p>Online payment isn't available right now. Please contact us.</p>`);

  // Data for the page script, in a data attribute rather than inline script
  // (the site's CSP forbids inline scripts). The amount is the server's.
  const cfg = esc(JSON.stringify({ key: keyId, order_id: o.rzp_order_id, amount: o.total_paise, receipt: o.receipt,
    name: o.cust_name || "", email: o.cust_email || "", contact: o.cust_phone || "" }));
  return page(`Complete payment · ${o.receipt}`, `
    <h1>Complete your payment</h1>
    <p class="sub">Order ${esc(o.receipt)} for ${esc(o.cust_name || "you")}</p>
    <table>${rows}</table>
    <button id="pay" class="pay" data-cfg="${cfg}">Pay ${rupeesText(o.total_paise)}</button>
    <p id="msg" class="msg" role="status" aria-live="polite"></p>
    <p class="note">Card, UPI and net banking via Razorpay's secure checkout. This page never sees your card details.</p>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <script src="/assets/js/paypending.js" defer></script>`);
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — AswinPrints</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b10; color:#f4f4f5; font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  main { max-width:460px; margin:0 auto; padding:32px 16px 48px; }
  h1 { font-size:1.5rem; margin:0 0 4px; } .sub { color:#a1a1aa; margin:0 0 18px; }
  table { width:100%; border-collapse:collapse; margin:0 0 18px; font-size:15px; }
  td { padding:9px 0; border-bottom:1px solid rgba(255,255,255,.08); } td.r { text-align:right; }
  tr.t td { font-weight:700; border-bottom:0; font-size:17px; }
  .pay { width:100%; min-height:48px; padding:14px; font-size:16px; font-weight:700; color:#111; background:#ff6b00; border:0; border-radius:12px; cursor:pointer; }
  .pay:disabled { opacity:.6; } .msg { min-height:1.2em; font-size:14px; } .msg.err { color:#f87171; } .msg.ok, .ok { color:#34d399; }
  .note { color:#a1a1aa; font-size:12.5px; line-height:1.5; } a { color:#ff8c38; }
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}
