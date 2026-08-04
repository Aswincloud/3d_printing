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
  `<p style="margin:0;font-size:13px;color:${MUTED}">Aswin Zayasankaran · ` +
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
      q.file_name ? ["File", esc(q.file_name) + " ✓"] : null,
      ["Description", esc(q.desc)],
    ]) +
    `</div>` +
    `<p style="color:${MUTED};font-size:14px;line-height:1.6;margin:0">Feel free to reply to this email if you have any questions or want to share more reference images.</p>` +
    button(base + "/#gallery", "View Our Gallery") +
    `</div>` + footer()
  );
}

// ── order confirmation → customer ─────────────────────────────────
export function orderCustomerEmail(env, order, items) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  const lines = items.map((it) =>
    `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px">${esc(it.name)}` +
    `<span style="color:${MUTED}"> × ${it.qty}</span></td>` +
    `<td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;text-align:right;font-weight:600">${rupees(it.price_paise * it.qty)}</td></tr>`
  ).join("");

  const totalRow = (label, value, bold) =>
    `<tr><td style="padding:${bold ? "12px" : "6px"} 0;font-size:${bold ? "16px" : "14px"};color:${bold ? TEXT : MUTED};${bold ? "font-weight:700" : ""}">${esc(label)}</td>` +
    `<td style="padding:${bold ? "12px" : "6px"} 0;text-align:right;font-size:${bold ? "16px" : "14px"};font-weight:${bold ? "700" : "600"};${bold ? `color:${ORANGE}` : ""}">${value}</td></tr>`;

  const address = order.delivery === "pickup"
    ? `<p style="margin:0;font-size:14px;line-height:1.6">Local pickup — I'll message you when it's ready to collect.</p>`
    : `<p style="margin:0;font-size:14px;line-height:1.6">${esc(order.cust_name)}<br>` +
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
    totalRow(order.shipping_paise === 0 ? "Shipping (free)" : "Shipping", rupees(order.shipping_paise)) +
    totalRow("Total paid", rupees(order.total_paise), true) +
    `</table></div>` +
    `<div style="background:${CARD};border-radius:10px;padding:20px;margin-bottom:8px">` +
    `<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:${MUTED}">${order.delivery === "pickup" ? "Collection" : "Shipping To"}</p>` +
    address + `</div>` +
    button(base + "/?receipt=" + encodeURIComponent(order.receipt), "View Order") +
    `</div>` + footer()
  );
}

// ── order notification → owner ────────────────────────────────────
export function orderOwnerEmail(env, order, items) {
  const base = env.APP_BASE_URL || "https://3d-prints.aswincloud.com";
  const lines = items.map((it) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid ${LINE};font-size:14px">${esc(it.name)} × ${it.qty}</td>` +
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
      ["Delivery", order.delivery === "pickup" ? "Local pickup" : "Ship"],
      order.delivery === "ship"
        ? ["Address", esc(`${order.addr_line}, ${order.addr_city}, ${order.addr_state} ${order.addr_pin}`)]
        : null,
      ["Payment ID", esc(order.rzp_payment_id || "—")],
      ["Subtotal", rupees(order.subtotal_paise)],
      ["Shipping", rupees(order.shipping_paise)],
      ["Total", `<span style="color:${ORANGE}">${rupees(order.total_paise)}</span>`],
      order.notes ? ["Notes", esc(order.notes)] : null,
    ]) +
    button(base + "/shop", "Open Dashboard") +
    `<div style="height:32px"></div></div>`
  );
}
