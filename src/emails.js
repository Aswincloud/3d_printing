// Email HTML. Lifted from the old .github/workflows/send-quote.yml so the
// look is unchanged — dark #0a0a0f body, orange gradient header, summary table.
//
// One substantive difference from the workflow version: every interpolated
// value goes through esc(). The shell/jq version dropped $NAME and $DESC into
// HTML raw, so a description containing markup was injected verbatim.

import { esc, rupees } from "./lib.js";

const BG = "#0a0a0f";
const CARD = "#1a1a24";
const LINE = "#22222e";
const TEXT = "#e8e8f0";
const MUTED = "#8888a0";
const ORANGE = "#ff6b00";
const GRAD = "linear-gradient(135deg,#ff6b00,#ff8c38)";

const shell = (inner) =>
  `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:${BG};color:${TEXT};border-radius:12px;overflow:hidden">${inner}</div>`;

const header = (title, sub) =>
  `<div style="background:${GRAD};padding:36px 32px;text-align:center">` +
  `<h1 style="margin:0;font-size:28px;color:white;letter-spacing:-0.5px">🖨️ ${esc(title)}</h1>` +
  `<p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px">${esc(sub)}</p></div>`;

const footer = () =>
  `<div style="background:#111118;padding:20px 32px;text-align:center;border-top:1px solid ${LINE}">` +
  `<p style="margin:0;font-size:13px;color:${MUTED}">Aswin · ` +
  `<a href="https://www.aswincloud.com" style="color:${ORANGE};text-decoration:none">aswincloud.com</a>` +
  ` · Pondicherry, India</p></div>`;

// esc() makes a URL safe to sit inside an attribute, but it does not stop a
// `javascript:` or `data:` scheme from becoming a live link. Anything that
// isn't plainly https/mailto is dropped rather than rendered.
const safeHref = (href) => {
  const h = String(href ?? "").trim();
  return /^(https:\/\/|mailto:)[^\s"'<>]+$/i.test(h) ? h : "";
};

const button = (href, label) => {
  const safe = safeHref(href);
  if (!safe) return "";
  return `<div style="text-align:center;margin-top:28px"><a href="${esc(safe)}" style="display:inline-block;background:${GRAD};color:white;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px">${esc(label)}</a></div>`;
};

// label/value rows; `value` is assumed pre-escaped by the caller
const rows = (pairs) =>
  `<table style="width:100%;border-collapse:collapse">` +
  pairs.filter(Boolean).map(([k, v], i, arr) => {
    const border = i === arr.length - 1 ? "" : `border-bottom:1px solid ${LINE};`;
    return `<tr><td style="padding:9px 0;${border}color:${MUTED};font-size:14px;width:120px">${esc(k)}</td>` +
      `<td style="padding:9px 0;${border}font-size:14px;font-weight:600">${v}</td></tr>`;
  }).join("") +
  `</table>`;

// ── quote request → owner ─────────────────────────────────────────
export function quoteOwnerEmail(env, q) {
  const fileBlock = q.file_url
    ? `<div style="margin-top:20px;background:${CARD};border-radius:10px;padding:16px">` +
      `<p style="margin:0;font-size:13px;color:${MUTED}">Attached File</p>` +
      `<p style="margin:4px 0 0;font-size:14px;font-weight:600">${esc(q.file_name)}</p>` +
      `<p style="margin:2px 0 0;font-size:12px;color:${MUTED}">Link expires in 72h</p>` +
      button(q.file_url, "Download") + `</div>`
    : "";

  return shell(
    `<div style="padding:32px 32px 0"><div style="border-bottom:2px solid ${ORANGE};padding-bottom:16px;margin-bottom:24px">` +
    `<h1 style="color:${ORANGE};margin:0;font-size:24px">🖨️ New Quote Request</h1>` +
    `<p style="color:${MUTED};margin:4px 0 0">${esc(env.APP_NAME || "AswinPrints")} — 3D Printing Services</p></div>` +
    rows([
      ["Name", esc(q.name)],
      ["Email", `<a href="mailto:${esc(q.email)}" style="color:${ORANGE}">${esc(q.email)}</a>`],
      ["Phone", esc(q.phone || "Not provided")],
      ["Print Type", esc(q.type)],
      ["Quantity", esc(q.qty)],
      q.ref_item ? ["About", esc(q.ref_item)] : null,
    ]) +
    `<div style="margin-top:24px"><p style="color:${MUTED};margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:1px">Description</p>` +
    `<div style="background:${CARD};border-left:3px solid ${ORANGE};padding:16px;border-radius:0 8px 8px 0;line-height:1.6">${esc(q.desc)}</div></div>` +
    fileBlock +
    button(`mailto:${encodeURIComponent(q.email)}`, "Reply to Customer") +
    `<div style="height:32px"></div></div>`
  );
}

// ── quote acknowledgement → customer ──────────────────────────────
export function quoteCustomerEmail(env, q) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  return shell(
    header(env.APP_NAME || "AswinPrints", "Custom 3D Printing · Pondicherry, India") +
    `<div style="padding:32px">` +
    `<h2 style="margin:0 0 8px;font-size:20px">Thanks, ${esc(q.name)}! 👋</h2>` +
    `<p style="color:${MUTED};margin:0 0 24px;line-height:1.6">I've received your quote request and will get back to you within a few hours with pricing and details.</p>` +
    `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:24px">` +
    `<p style="margin:0 0 14px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">Your Request Summary</p>` +
    rows([
      ["Print Type", esc(q.type)],
      ["Quantity", esc(q.qty)],
      q.ref_item ? ["About", esc(q.ref_item)] : null,
      q.file_name ? ["File", esc(q.file_name) + " ✓"] : null,
      ["Description", esc(q.desc)],
    ]) +
    `</div>` +
    `<p style="color:${MUTED};font-size:14px;line-height:1.6;margin:0">Feel free to reply to this email if you have any questions or want to share more reference images.</p>` +
    button(base + "/#gallery", "View Our Gallery") +
    `</div>` + footer()
  );
}

// What the customer asked to be printed on a personalised item. Rendered on its
// own line under the product rather than appended to the name, because on the
// owner's copy this IS the print instruction — it has to be readable at a glance
// next to the thing it applies to, not buried in a run-on line.
//
// esc() like every other value here: it is customer-typed text.
const pzLine = (it, colour) => (String(it.personalisation || "").trim()
  ? `<div style="font-size:12px;color:${colour};margin-top:3px">${esc(it.personalisation)}</div>`
  : "");

// ── order confirmation → customer ─────────────────────────────────
export function orderCustomerEmail(env, order, items) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  const lines = items.map((it) =>
    `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px">${esc(it.name)}` +
    `<span style="color:${MUTED}"> × ${it.qty}</span>${pzLine(it, MUTED)}</td>` +
    `<td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;text-align:right;font-weight:600">${rupees(it.price_paise * it.qty)}</td></tr>`
  ).join("");

  const totalRow = (label, value, bold) =>
    `<tr><td style="padding:${bold ? "12px" : "6px"} 0;font-size:${bold ? "16px" : "14px"};color:${bold ? TEXT : MUTED};${bold ? "font-weight:700" : ""}">${esc(label)}</td>` +
    `<td style="padding:${bold ? "12px" : "6px"} 0;text-align:right;font-size:${bold ? "16px" : "14px"};font-weight:${bold ? "700" : "600"};${bold ? `color:${ORANGE}` : ""}">${value}</td></tr>`;

  // Every order ships — local pickup was withdrawn, so there is no collection
  // variant of this block any more.
  const address =
    `<p style="margin:0;font-size:14px;line-height:1.6">${esc(order.cust_name)}<br>` +
    `${esc(order.addr_line)}<br>${esc(order.addr_city)}, ${esc(order.addr_state)} ${esc(order.addr_pin)}</p>`;

  return shell(
    header(env.APP_NAME || "AswinPrints", "Order confirmed · Thank you!") +
    `<div style="padding:32px">` +
    `<h2 style="margin:0 0 8px;font-size:20px">Payment received, ${esc(order.cust_name)} ✅</h2>` +
    `<p style="color:${MUTED};margin:0 0 8px;line-height:1.6">Your order is confirmed and heading into the print queue. I'll email you again when it ships.</p>` +
    `<p style="margin:0 0 24px;font-size:14px;color:${MUTED}">Order reference <strong style="color:${ORANGE}">${esc(order.receipt)}</strong></p>` +
    `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:24px">` +
    `<p style="margin:0 0 14px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">Order Summary</p>` +
    `<table style="width:100%;border-collapse:collapse">${lines}` +
    totalRow("Subtotal", rupees(order.subtotal_paise)) +
    // Only when there was one. A "Discount ₹0" line on every receipt would be
    // noise. esc() because the code is admin-editable text landing in HTML.
    (order.discount_paise > 0
      ? totalRow(`Promo ${esc(order.coupon_code || "")}`, "−" + rupees(order.discount_paise))
      : "") +
    totalRow(order.shipping_paise === 0 ? "Shipping (free)" : "Shipping", rupees(order.shipping_paise)) +
    totalRow("Total paid", rupees(order.total_paise), true) +
    `</table></div>` +
    `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:8px">` +
    `<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">Shipping To</p>` +
    address + `</div>` +
    button(base + "/?receipt=" + encodeURIComponent(order.receipt), "View Order") +
    `</div>` + footer()
  );
}

// ── shipped notification → customer ───────────────────────────────
//
// The confirmation email promises "I'll email you again when it ships", which
// until now was a promise the code did not keep — marking an order shipped
// changed a status column and told the customer nothing.
//
// Courier and tracking are both optional. A print handed to a local courier with
// no tracking number is still worth telling someone about, so the email works
// with neither, either, or both rather than being blocked on data that may not
// exist.
export function orderShippedEmail(env, order, { courier, tracking, trackingUrl } = {}) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";

  const detail = [
    courier ? ["Courier", esc(courier)] : null,
    // Monospace: a tracking id is a string to be copied character by character,
    // and a proportional font makes 0/O and 1/l ambiguous.
    tracking
      ? ["Tracking", `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(tracking)}</span>`]
      : null,
  ].filter(Boolean);

  return shell(
    header(env.APP_NAME || "AswinPrints", "On its way 📦") +
    `<div style="padding:32px">` +
    `<h2 style="margin:0 0 8px;font-size:20px">Your order has shipped, ${esc(order.cust_name)}</h2>` +
    `<p style="color:${MUTED};margin:0 0 8px;line-height:1.6">` +
    (tracking
      ? "It's on the way — you can follow it with the tracking details below."
      : "It's on the way. I'll be in touch if anything changes.") +
    `</p>` +
    `<p style="margin:0 0 24px;font-size:14px;color:${MUTED}">Order reference <strong style="color:${ORANGE}">${esc(order.receipt)}</strong></p>` +

    (detail.length
      ? `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:24px">` +
        `<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">Tracking</p>` +
        rows(detail) + `</div>`
      : "") +

    `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:8px">` +
    `<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">Shipping To</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.6">${esc(order.cust_name)}<br>` +
    `${esc(order.addr_line)}<br>${esc(order.addr_city)}, ${esc(order.addr_state)} ${esc(order.addr_pin)}</p>` +
    `</div>` +

    // The courier's own tracking page when one was given, otherwise the receipt.
    // safeHref inside button() drops anything that is not https, so a mistyped
    // url degrades to no button rather than a broken or dangerous link.
    (trackingUrl
      ? button(trackingUrl, "Track your parcel")
      : button(base + "/?receipt=" + encodeURIComponent(order.receipt), "View Order")) +
    `</div>` + footer()
  );
}

// ── the quotation → customer ──────────────────────────────────────
// The reason the dashboard reply exists. Every quote used to be answered by hand,
// so pricing emails looked different every time; this is the one format, with the
// price and the Pay button in it.
export function quotationEmail(env, quote) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  const asked = [
    quote.ref_item ? ["About", quote.ref_item] : null,
    quote.type ? ["Type", quote.type] : null,
    ["Quantity", String(quote.qty || 1)],
  ].filter(Boolean);

  const expires = Number(quote.plink_expires) > 0
    ? new Date(Number(quote.plink_expires)).toLocaleDateString("en-IN",
        { day: "numeric", month: "long", year: "numeric" })
    : "";

  return shell(
    header("Your Quote", `${esc(quote.receipt)}`) +
    `<div style="padding:28px 32px 32px">` +
    `<p style="font-size:15px;margin:0 0 18px">Hi ${esc(quote.cust_name || "there")},</p>` +

    (quote.reply_note
      ? `<div style="font-size:14px;line-height:1.65;white-space:pre-wrap;margin-bottom:22px">${esc(quote.reply_note)}</div>`
      : "") +

    // The number, given its own block. A price buried in a paragraph is a price
    // that gets missed and asked about again.
    `<div style="border:1px solid ${LINE};border-radius:12px;padding:18px;text-align:center;margin-bottom:22px">` +
      `<div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em">Your price</div>` +
      `<div style="font-size:30px;font-weight:800;color:${ORANGE};margin-top:4px">${rupees(quote.quoted_paise)}</div>` +
    `</div>` +

    (quote.plink_url
      ? `<div style="text-align:center;margin-bottom:8px">` +
        `<a href="${esc(quote.plink_url)}" style="display:inline-block;background:${ORANGE};` +
        `color:#0a0a0f;font-weight:700;font-size:15px;text-decoration:none;` +
        `padding:13px 34px;border-radius:10px">Accept &amp; Pay ${esc(rupees(quote.quoted_paise))}</a></div>` +
        (expires ? `<p style="text-align:center;font-size:12px;color:${MUTED};margin:10px 0 0">` +
                   `This link is valid until ${esc(expires)}.</p>` : "")
      : "") +

    `<table style="width:100%;border-collapse:collapse;margin-top:26px">` +
    asked.map(([k, v]) =>
      `<tr><td style="padding:7px 0;border-bottom:1px solid ${LINE};font-size:13px;color:${MUTED};width:110px">${esc(k)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid ${LINE};font-size:13px">${esc(v)}</td></tr>`
    ).join("") +
    `</table>` +

    `<p style="font-size:13px;color:${MUTED};margin-top:22px;line-height:1.6">` +
    `Reply to this email if anything needs changing before you pay — the price, the ` +
    `colour, the quantity. I'll send an updated quote.</p>` +

    `<p style="font-size:13px;color:${MUTED};margin-top:18px">— Aswin<br>` +
    `<a href="${esc(base)}" style="color:${ORANGE}">${esc(base.replace(/^https?:\/\//, ""))}</a></p>` +
    `</div>`
  );
}

// ── a payment we could not attribute → owner ──────────────────────
//
// The alarm. A payment_link.paid that does not resolve to a quote means money has
// arrived and NOTHING was created for it: no order, no receipt, no invoice, no
// email to the customer. Before this the handler logged a line and returned 200,
// so Razorpay was told "handled" and the only trace was a console entry nobody
// reads — the failure was invisible exactly where it is most expensive.
//
// Written to be actionable at 11pm on a phone: every id needed to find the
// payment in the Razorpay dashboard and refund or fulfil it by hand.
export function unmatchedPaymentEmail(env, d) {
  const row = (k, v) => (v
    ? `<tr><td style="padding:7px 0;border-bottom:1px solid ${LINE};font-size:13px;color:${MUTED};width:130px">${esc(k)}</td>`
      + `<td style="padding:7px 0;border-bottom:1px solid ${LINE};font-size:13px;font-family:monospace">${esc(String(v))}</td></tr>`
    : "");

  return shell(
    `<div style="padding:32px 32px 0">` +
    `<div style="border-bottom:2px solid ${ORANGE};padding-bottom:16px;margin-bottom:20px">` +
    `<h1 style="color:${ORANGE};margin:0;font-size:22px">Payment received with no order</h1>` +
    `<p style="color:${MUTED};margin:6px 0 0;font-size:14px">` +
    `A payment link was paid, but it could not be matched to a quote — so no order ` +
    `was created and the customer has had no confirmation.</p></div>` +

    `<p style="font-size:15px;margin:0 0 4px"><strong>Amount: ${esc(rupees(d.amountPaise))}</strong></p>` +
    `<p style="font-size:13px;color:${MUTED};margin:0 0 20px">${esc(d.reason)}</p>` +

    `<table style="width:100%;border-collapse:collapse;margin-bottom:22px">` +
    row("Reference", d.receipt || "(none sent)") +
    row("Payment link", d.linkId) +
    row("Razorpay order", d.rzpOrderId) +
    row("Payment id", d.paymentId) +
    row("Customer", d.email) +
    `</table>` +

    `<p style="font-size:13px;color:${MUTED};line-height:1.6">` +
    `Find the payment id in the Razorpay dashboard to see who paid and refund or ` +
    `fulfil it by hand. If this keeps happening, the payment_link.paid payload has ` +
    `changed shape and <code>handleQuotePaid</code> in src/orders.js needs updating.</p>` +
    `</div>`
  );
}

// ── order notification → owner ────────────────────────────────────
export function orderOwnerEmail(env, order, items) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  const lines = items.map((it) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid ${LINE};font-size:14px">${esc(it.name)} × ${it.qty}${pzLine(it, ORANGE)}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid ${LINE};font-size:14px;text-align:right">${rupees(it.price_paise * it.qty)}</td></tr>`
  ).join("");

  return shell(
    `<div style="padding:32px 32px 0"><div style="border-bottom:2px solid ${ORANGE};padding-bottom:16px;margin-bottom:24px">` +
    `<h1 style="color:${ORANGE};margin:0;font-size:24px">💰 New Paid Order</h1>` +
    `<p style="color:${MUTED};margin:4px 0 0">${esc(order.receipt)} · ${rupees(order.total_paise)}</p></div>` +
    `<table style="width:100%;border-collapse:collapse;margin-bottom:20px">${lines}</table>` +
    rows([
      ["Customer", esc(order.cust_name)],
      ["Email", `<a href="mailto:${esc(order.cust_email)}" style="color:${ORANGE}">${esc(order.cust_email)}</a>`],
      ["Phone", esc(order.cust_phone || "—")],
      // No "Delivery" row: every order ships, so it carried no information.
      ["Address", esc(`${order.addr_line}, ${order.addr_city}, ${order.addr_state} ${order.addr_pin}`)],
      ["Payment ID", esc(order.rzp_payment_id || "—")],
      ["Subtotal", rupees(order.subtotal_paise)],
      // Aswin needs to see WHICH code was used, not just that the total is lower
      // — otherwise a promo's real cost is invisible in the order mail.
      order.discount_paise > 0
        ? ["Discount", `${esc(order.coupon_code || "")} −${rupees(order.discount_paise)}`]
        : null,
      ["Shipping", rupees(order.shipping_paise)],
      ["Total", `<span style="color:${ORANGE}">${rupees(order.total_paise)}</span>`],
      order.notes ? ["Notes", esc(order.notes)] : null,
    ]) +
    button(base + "/shop", "Open Dashboard") +
    `<div style="height:32px"></div></div>`
  );
}
