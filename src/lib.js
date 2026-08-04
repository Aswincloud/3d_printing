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
