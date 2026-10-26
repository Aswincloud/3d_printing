// Order tracking for everyone, guests included (2026-10-26).
//
// Half the shop's paid orders are guest checkouts, and until now a guest had no
// way to see an order: My Orders needs an account, and the "View Order" button in
// every order email pointed at /?receipt=… which nothing read.
//
//   POST /api/track  { receipt, contact }  → the order, or one generic 404.
//     `contact` is the email OR the phone used at checkout. Both the receipt and
//     the contact must match: the receipt alone is printed on parcels and
//     screenshots, so it is not a secret on its own. A miss never says which half
//     was wrong. Rate limited per IP (RL_TRACK).
//   GET /track  — the page with the form; /track?t=<pay_token> opens one order
//     directly (the emails' "View Order" link). The token is the order's private
//     32-hex key, the same one /o/ and /thank-you use.
//
// What a customer sees comes from customerOrder(), shared with My Orders, so the
// two can never disagree about an order.
import { json, bad, statusLabel, stageTimeline, trackingUrlFor } from "./lib.js";

const RECEIPT_RE = /^AP-[0-9a-f]{8}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const phoneKey = (s) => String(s || "").replace(/\D/g, "").slice(-10);

const COLUMNS = `id, receipt, status, subtotal_paise, discount_paise, coupon_code, shipping_paise, total_paise,
  cust_email, cust_phone, courier, tracking_id, created_at, paid_at, production_at, ready_at, shipped_at, delivered_at`;

// What one customer may see about one of their orders. No address, no email, no
// phone, no payment ids — the page is reachable by anyone holding the link.
export async function customerOrder(env, o) {
  const { results } = await env.DB.prepare(
    `SELECT name, price_paise, qty, personalisation FROM order_items WHERE order_id = ? ORDER BY pos`).bind(o.id).all();
  const shipped = ["shipped", "delivered"].includes(o.status);
  return {
    receipt: o.receipt, status: o.status, status_label: statusLabel(o.status), stages: stageTimeline(o),
    items: (results || []).map((i) => ({ name: i.name, qty: i.qty, price_paise: i.price_paise, personalisation: i.personalisation || "" })),
    subtotal_paise: o.subtotal_paise, discount_paise: o.discount_paise || 0, coupon_code: o.coupon_code || null,
    shipping_paise: o.shipping_paise, total_paise: o.total_paise, created_at: o.created_at,
    // Tracking only once it has shipped: a number typed in early is a draft.
    courier: shipped ? (o.courier || null) : null,
    tracking_id: shipped ? (o.tracking_id || null) : null,
    tracking_url: shipped ? (trackingUrlFor(o.courier, o.tracking_id) || null) : null,
  };
}

// Only orders a customer actually placed: an abandoned checkout is not an order.
const VISIBLE = new Set(["paid", "in_production", "ready", "shipped", "delivered", "cancelled", "refunded"]);
const NOT_FOUND = () => bad("We couldn't find an order with those details. Check the order number (it starts with AP-) and use the email or phone you checked out with.", 404);

export async function trackLookup(env, body) {
  const receipt = String(body?.receipt || "").trim().toLowerCase().replace(/^ap-/, "AP-");
  const contact = String(body?.contact || "").trim();
  if (!RECEIPT_RE.test(receipt) || !contact || contact.length > 200) return NOT_FOUND();

  const o = await env.DB.prepare(`SELECT ${COLUMNS} FROM orders WHERE receipt = ?`).bind(receipt).first();
  if (!o || !VISIBLE.has(o.status)) return NOT_FOUND();

  const email = contact.toLowerCase();
  const digits = phoneKey(contact);
  const emailOk = email.includes("@") && email === String(o.cust_email || "").trim().toLowerCase();
  const phoneOk = digits.length === 10 && digits === phoneKey(o.cust_phone);
  if (!emailOk && !phoneOk) return NOT_FOUND();

  return json({ order: await customerOrder(env, o) });
}

export async function trackByToken(env, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const o = await env.DB.prepare(`SELECT ${COLUMNS} FROM orders WHERE pay_token = ?`).bind(token).first();
  if (!o || !VISIBLE.has(o.status)) return null;
  return customerOrder(env, o);
}

// ── GET /track ────────────────────────────────────────────────────
// Server-rendered: the form posts to the API from /assets/js/track.js, and an
// emailed link (?t=) renders the order straight away, no JavaScript needed.
import { esc, rupeesText } from "./pagebits.js";

const fmtDate = (ms) => ms ? new Date(Number(ms)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

export function orderHtml(o) {
  const steps = o.stages
    ? `<ol class="steps">${o.stages.map((s) => `<li class="${s.done ? "done" : ""}${s.current ? " cur" : ""}"><span>${esc(s.label)}</span>${s.at ? `<small>${esc(fmtDate(s.at))}</small>` : ""}</li>`).join("")}</ol>`
    : `<p class="badge">${esc(o.status_label)}</p>`;
  const ship = o.tracking_id
    ? `<div class="ship"><strong>Shipped${o.courier ? " with " + esc(o.courier) : ""}</strong><span>Tracking number <code>${esc(o.tracking_id)}</code></span>${o.tracking_url ? `<a class="btn" href="${esc(o.tracking_url)}" target="_blank" rel="noopener noreferrer">Track the parcel</a>` : ""}</div>`
    : "";
  const rows = o.items.map((it) => `<tr><td>${esc(it.name)} × ${it.qty}${it.personalisation ? `<br><small>“${esc(it.personalisation)}”</small>` : ""}</td><td class="r">${rupeesText(it.price_paise * it.qty)}</td></tr>`).join("") +
    (o.discount_paise > 0 ? `<tr><td>Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ""}</td><td class="r">−${rupeesText(o.discount_paise)}</td></tr>` : "") +
    `<tr><td>Shipping</td><td class="r">${o.shipping_paise ? rupeesText(o.shipping_paise) : "Free"}</td></tr>` +
    `<tr class="t"><td>Total</td><td class="r">${rupeesText(o.total_paise)}</td></tr>`;
  return `<section class="order"><h2>Order ${esc(o.receipt)}</h2><p class="sub">Placed ${esc(fmtDate(o.created_at))}</p>${steps}${ship}<table>${rows}</table></section>`;
}

export async function trackPage(env, url) {
  const order = url.searchParams.get("t") ? await trackByToken(env, url.searchParams.get("t")) : null;
  const body = `
    <h1>Track your order</h1>
    <p class="sub">Enter your order number and the email or phone you used at checkout.</p>
    <form id="trackForm" class="form" novalidate>
      <label>Order number<input name="receipt" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AP-1a2b3c4d" required></label>
      <label>Email or phone<input name="contact" autocomplete="email" placeholder="you@example.com or 98765 43210" required></label>
      <button type="submit" class="btn">Track order</button>
      <p id="trackMsg" class="msg" role="status" aria-live="polite"></p>
    </form>
    <p class="hint">Signed in? <a href="/#orders">See all your orders</a>. Your order number is in your confirmation email and WhatsApp.</p>
    <div id="trackResult">${order ? orderHtml(order) : ""}</div>
    <script src="/assets/js/track.js" defer></script>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Track your order — AswinPrints</title>
<meta name="description" content="Track your AswinPrints order with your order number and the email or phone you used at checkout.">
${order ? `<meta name="robots" content="noindex,nofollow">` : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b10; color:#f4f4f5; font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  main { max-width:520px; margin:0 auto; padding:28px 16px 56px; }
  .home { color:#ff8c38; text-decoration:none; font-weight:700; } h1 { font-size:1.6rem; margin:18px 0 6px; } h2 { font-size:1.2rem; margin:0 0 2px; }
  .sub, .hint { color:#a1a1aa; margin:0 0 18px; } .hint { font-size:14px; margin-top:6px; }
  .form { display:grid; gap:12px; } label { display:grid; gap:6px; font-size:14px; color:#d4d4d8; }
  input { font-size:16px; min-height:44px; padding:0 12px; border-radius:10px; border:1px solid #2a2a36; background:#15151d; color:#f4f4f5; }
  .btn { display:inline-block; min-height:44px; line-height:44px; padding:0 20px; font-weight:700; font-size:16px; color:#111; background:#ff6b00; border:0; border-radius:12px; text-decoration:none; cursor:pointer; }
  .msg { min-height:1.2em; margin:0; font-size:14px; } .msg.err { color:#f87171; }
  .order { margin-top:24px; padding:18px 16px; border:1px solid #22222e; border-radius:14px; background:#13131a; }
  .steps { list-style:none; margin:16px 0; padding:0; display:grid; gap:10px; }
  .steps li { position:relative; padding-left:28px; color:#71717a; } .steps li::before { content:""; position:absolute; left:4px; top:4px; width:12px; height:12px; border-radius:50%; border:2px solid #3f3f46; }
  .steps li.done { color:#f4f4f5; } .steps li.done::before { background:#16a34a; border-color:#16a34a; } .steps li.cur span { font-weight:700; }
  .steps small { display:block; color:#a1a1aa; font-size:12.5px; }
  .badge { display:inline-block; padding:4px 10px; border-radius:999px; background:#3f3f46; margin:14px 0; }
  .ship { display:grid; gap:6px; margin:6px 0 16px; padding:12px; border-radius:10px; background:#0f2a1a; } code { font-size:15px; }
  table { width:100%; border-collapse:collapse; font-size:15px; } td { padding:9px 0; border-bottom:1px solid rgba(255,255,255,.08); vertical-align:top; } td.r { text-align:right; white-space:nowrap; }
  td small { color:#a1a1aa; } tr.t td { font-weight:700; border-bottom:0; font-size:17px; } a { color:#ff8c38; }
</style></head><body><main><a class="home" href="/">← AswinPrints</a>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...(order ? { "x-robots-tag": "noindex, nofollow" } : {}) } });
}
