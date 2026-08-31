// Shared helpers: JSON responses, ids, HMAC, HTML escaping, Resend email.
// Ported from ~/projects/invoicer/src/lib.js. Differences noted inline.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const bad = (msg, status = 400) => json({ error: msg }, status);

export const uid = () => crypto.randomUUID();

// short random hex token
export function randToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const now = () => Date.now();

// ── HMAC-SHA256 ───────────────────────────────────────────────────
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Invoicer's sign()/unsign() are base64url AND glue the payload onto the
// signature (`value.sig`). Razorpay sends a bare lowercase hex digest in a
// header, so it needs its own primitive rather than a reuse of those.
export async function hmacHex(message, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare of two hex digests. Length is compared first and
// non-secret (it's a fixed 64 chars for SHA-256), so an early return there
// leaks nothing.
export function timingSafeEqualHex(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function sign(value, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${value}.${b64}`;
}

export async function unsign(signed, secret) {
  const i = String(signed || "").lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = await sign(value, secret);
  if (expected.length !== signed.length) return null;
  let diff = 0;
  for (let j = 0; j < expected.length; j++) diff |= expected.charCodeAt(j) ^ signed.charCodeAt(j);
  return diff === 0 ? value : null;
}

// ── cookies ───────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  const h = req.headers.get("cookie") || "";
  h.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function cookie(name, value, { maxAge = 60 * 60 * 24 * 30, del = false } = {}) {
  return [
    `${name}=${del ? "" : encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    `Max-Age=${del ? 0 : maxAge}`,
  ].join("; ");
}

// ── HTML escaping ─────────────────────────────────────────────────
// The old send-quote.yml workflow interpolated customer input straight into
// email HTML ($NAME, $DESC). Every value that reaches an email template here
// goes through this first.
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── money ─────────────────────────────────────────────────────────
// Money is INTEGER paise everywhere (invoicer uses REAL; Razorpay's API is
// integer-paise native and float rupees drift when summed).
export const rupees = (paise) =>
  "₹" + (Math.round(Number(paise) || 0) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

// ── the struck-through "MRP" shown beside the selling price ───────
//
// A DISPLAY figure, computed as the selling price + 15%. Aswin asked for this after
// being told what it is: no item has ever been sold at the higher number, so it is a
// fabricated reference price rather than a former one. That is the pattern India's
// CCPA Guidelines for Prevention and Regulation of Dark Patterns (2023) describe,
// and "MRP" is a defined term under the Legal Metrology (Packaged Commodities)
// Rules rather than a marketing figure. His shop, his decision — recorded here so
// whoever reads this next knows the number is derived and not historical, and does
// not mistake it for data.
//
// WHERE IT MUST NOT GO, and this is the part to preserve if anything here changes:
//
//   * the cart, checkout, Razorpay amount, invoices, order emails. Those state money
//     actually charged, and a fabricated "you saved ₹X" beside a real total is a
//     different and much worse claim than a struck price on a card.
//   * the JSON-LD on product pages. That is a machine-readable price claim made to
//     Google; the structured data keeps declaring the real selling price, which is
//     accurate. Nothing about the on-page display needs it there.
//
// So it is exported from here rather than inlined, and every caller is a display
// surface. test/pricing-display.mjs asserts the exclusions above by name.
export const COMPARE_AT_MULTIPLIER = 1.15;

export const compareAtPaise = (paise) => {
  const p = Math.round(Number(paise) || 0);
  // Quote-only products (0) and anything non-numeric get nothing, rather than a
  // struck "₹0" next to "Price on request".
  if (!(p > 0)) return 0;
  // Rounded to whole RUPEES, not whole paise. p is in paise, so a bare
  // Math.round(p * 1.15) leaves ₹399 showing as "₹458.85" — a reference price with
  // two decimals reads as a number a computer produced, which is the one thing it
  // must not look like. Rounding to the rupee gives ₹459.
  return Math.round((p * COMPARE_AT_MULTIPLIER) / 100) * 100;
};

// The percentage is derived from the two numbers actually shown, not hardcoded to
// 15. Rounding moves it — ₹99 becomes ₹114, which is 13% off, not 15 — and a badge
// claiming a discount the arithmetic beside it contradicts is worse than no badge.
export const comparePercentOff = (paise) => {
  const was = compareAtPaise(paise), now = Math.round(Number(paise) || 0);
  if (!(was > now) || !(now > 0)) return 0;
  return Math.round(((was - now) / was) * 100);
};

// ── Resend email (NOTE: User-Agent header is REQUIRED or Resend 403s /1010) ──
function fromHeader(env, name) {
  const addr = env.RESEND_FROM_EMAIL || "noreply@aswincloud.com";
  const clean = String(name || "").replace(/[<>",;\r\n]/g, " ").trim().slice(0, 78);
  return clean ? `${clean} <${addr}>` : addr;
}

// `replyTo` added over invoicer's version: quote mails set it to the customer
// so Aswin can just hit reply.
export async function sendEmail(env, { to, subject, html, text, fromName, replyTo }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  const payload = {
    from: fromHeader(env, fromName || env.APP_NAME),
    to: Array.isArray(to) ? to : [to],
    subject, html, text,
  };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "3d-prints/1.0 (+cloudflare-worker)",
    },
    body: JSON.stringify(payload),
  });
  if (r.ok) return { ok: true, id: (await r.json().catch(() => ({}))).id };
  return { ok: false, status: r.status, error: await r.text().catch(() => "") };
}

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || "");

// ── order stages ──────────────────────────────────────────────────
//
// ONE definition of the pipeline, imported by the state machine in admin.js, the
// customer's order list, the dashboard and the chat bot. It used to be that the
// only status a customer saw was the raw database value — the badge in My Orders
// literally rendered the word `shipped` — and every place that wanted to spell a
// status nicely would have needed its own copy of this map.
//
// ORDER MATTERS: this array IS the pipeline, and `stageTimeline()` below relies
// on the sequence to work out what a customer has already passed.
export const ORDER_STAGES = [
  { key: "pending",       label: "Placed",        at: "created_at" },
  { key: "paid",          label: "Confirmed",     at: "paid_at" },
  { key: "in_production", label: "In production", at: "production_at" },
  { key: "ready",         label: "Ready to ship", at: "ready_at" },
  { key: "shipped",       label: "Shipped",       at: "shipped_at" },
  { key: "delivered",     label: "Delivered",     at: "delivered_at" },
];

// Not stages — they end the pipeline rather than advancing it, so an order in one
// of these renders a single badge and no tracker. A half-drawn progress bar with
// a dead end in the middle tells a customer less than the plain word does.
export const TERMINAL_STATUSES = {
  cancelled: "Cancelled",
  refunded: "Refunded",
  failed: "Payment failed",
};

const STAGE_LABEL = Object.fromEntries(ORDER_STAGES.map((s) => [s.key, s.label]));

export const statusLabel = (status) =>
  STAGE_LABEL[status] || TERMINAL_STATUSES[status] || String(status || "");

// What the customer's progress tracker draws.
//
// THE STATUS IS THE AUTHORITY on how far an order has got; the timestamps only
// say WHEN. A stage counts as done when it is at or before the current status,
// or its own timestamp is set, or a later stage has one. Three clauses because
// there are three ways the data arrives incomplete, and all of them are real:
//
//   1. An order that skipped ahead — paid -> shipped in one click, which stays
//      legal so something already on the shelf does not need four clicks.
//   2. Rows that predate these columns: shipped before this feature existed, so
//      they carry a shipped_at and nulls everywhere behind it.
//   3. Rows with a status and NO timestamp at all. AP-cp000002 is exactly this
//      live — status 'shipped', shipped_at null — and keying only off timestamps
//      drew it as "x---*-": one step done, under a badge saying Shipped.
//
// Returns null for a terminal status, which is the caller's signal to render the
// badge instead.
export function stageTimeline(order) {
  if (order.status in TERMINAL_STATUSES) return null;

  const at = ORDER_STAGES.map((s) => {
    const v = order[s.at];
    return v === null || v === undefined ? null : Number(v);
  });

  const currentIndex = ORDER_STAGES.findIndex((s) => s.key === order.status);

  // Scanned from the end so "some later stage happened" is carried backwards in
  // one pass rather than re-searched per stage.
  let laterHappened = false;
  const done = new Array(ORDER_STAGES.length);
  for (let i = ORDER_STAGES.length - 1; i >= 0; i--) {
    done[i] = (currentIndex >= 0 && i <= currentIndex) || at[i] !== null || laterHappened;
    if (done[i]) laterHappened = true;
  }

  return ORDER_STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    // Null where the stage was skipped or predates the column. The client shows
    // the step as reached, without inventing a time it cannot know.
    at: at[i],
    done: done[i],
    current: i === currentIndex,
  }));
}
