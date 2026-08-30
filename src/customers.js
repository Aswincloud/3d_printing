// Customer accounts: passwordless sign-in by emailed code, order history.
//
// Deliberately SEPARATE from src/auth.js, which handles owner/admin sign-in via
// the auth.aswincloud.com broker. Two schemes, two cookies, two token purposes:
//
//   admin     ap_session   purpose "owner_session"     → src/auth.js
//   customer  ap_user      purpose "customer_session"   → this file
//
// The purpose string is bound into the HMAC by signToken, so a customer cookie
// presented at /api/admin/* fails *signature verification* — not merely a string
// comparison that someone could later refactor away. That's invariant 7, and
// test/customers.mjs asserts it in both directions.
//
// The OTP primitives come from @aswincloud/auth. Its higher-level signup() /
// verifyOtp() flows are NOT used: both require a password (signup rejects < 8
// chars, and its users.password_hash is NOT NULL), which a passwordless site has
// no use for. The three primitives plus the otp_codes table give us the good
// parts — peppered hashes, an attempts counter, a resend cooldown — without the
// password baggage.

import {
  signToken, verifyToken,
} from "@aswincloud/auth";
import {
  generateOtp, hashOtp, otpHashEquals,
  OTP_TTL_SECONDS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS,
  upsertOtp, getOtp, incrementOtpAttempts, deleteOtp,
  otpEmail,
} from "@aswincloud/auth/d1";
import { json, bad, uid, now, isEmail, sendEmail, hmacHex } from "./lib.js";

const USER_COOKIE = "ap_user";
const USER_PURPOSE = "customer_session";
const USER_TTL_SECONDS = 30 * 24 * 60 * 60;    // 30 days

// Per-email throttle on the send endpoint. The package caps *guesses*
// (OTP_MAX_ATTEMPTS) and *resends* (OTP_RESEND_COOLDOWN_SECONDS) but has nothing
// for "how many codes may one address be sent an hour" — that's ours.
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const normEmail = (v) => clip(v, 160).toLowerCase();

export const accountsConfigured = (env) => Boolean(env.SESSION_SECRET);

// The pepper mixed into the stored code hash. Falls back to SESSION_SECRET so a
// deployment can't silently end up with an empty pepper.
const pepper = (env) => env.OTP_PEPPER || env.SESSION_SECRET || "";

// ── session ───────────────────────────────────────────────────────
// The cookie carries the USER ID, not the email: an email change shouldn't
// invalidate a session, and the id is what every scoped query keys on.
async function setSession(userId, env) {
  return signToken(env.SESSION_SECRET, userId, USER_PURPOSE, USER_TTL_SECONDS);
}

// Returns the user row, or null. Called by the positional gate in index.js for
// every /api/me/* request.
export async function currentCustomer(request, env) {
  if (!accountsConfigured(env)) return null;
  const raw = parseCookie(request, USER_COOKIE);
  if (!raw) return null;
  const userId = await verifyToken(env.SESSION_SECRET, raw, USER_PURPOSE);
  if (!userId) return null;
  const user = await env.DB.prepare(
    `SELECT id, email, name, created_at, phone, addr_line, addr_city, addr_state, addr_pin
       FROM users WHERE id = ?`
  ).bind(userId).first();
  // A deleted account must not keep a working session.
  return user || null;
}

// Local cookie reader — lib.js's parseCookies takes the whole request and
// returns everything; this is just the one-key convenience.
function parseCookie(request, name) {
  const h = request.headers.get("cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function sessionCookie(value, { del = false } = {}) {
  return [
    `${USER_COOKIE}=${del ? "" : encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    `Max-Age=${del ? 0 : USER_TTL_SECONDS}`,
  ].join("; ");
}

// ── rate limiting ─────────────────────────────────────────────────
// Returns true if this address may be sent another code.
async function allowSend(env, email) {
  const t = now();
  const row = await env.DB.prepare(
    `SELECT count, window_start FROM otp_requests WHERE email = ?`
  ).bind(email).first();

  if (!row || t - row.window_start > SEND_WINDOW_MS) {
    await env.DB.prepare(
      `INSERT INTO otp_requests (email, count, window_start) VALUES (?,1,?)
       ON CONFLICT(email) DO UPDATE SET count = 1, window_start = ?`
    ).bind(email, t, t).run();
    return true;
  }

  if (row.count >= MAX_SENDS_PER_WINDOW) return false;

  await env.DB.prepare(
    `UPDATE otp_requests SET count = count + 1 WHERE email = ?`
  ).bind(email).run();
  return true;
}

// ── POST /api/auth/code ───────────────────────────────────────────
// Emails a 6-digit code.
//
// ALWAYS returns {ok:true} — for an unknown address, a throttled address, and a
// failed send alike. Anything else turns this endpoint into an account-existence
// oracle, which is the same reasoning behind the package's own
// requestPasswordReset always returning ok. The caller learns nothing; the
// server logs everything.
export async function requestCode(request, env, ctx, body) {
  const email = normEmail(body?.email);
  const ok = () => json({ ok: true, ttl_minutes: Math.round(OTP_TTL_SECONDS / 60) });

  if (!isEmail(email)) return bad("Please enter a valid email address.", 400);

  if (!accountsConfigured(env)) {
    console.error("sign-in attempted but SESSION_SECRET is unset");
    return bad("Sign-in isn't set up yet. Please email aswin@aswincloud.com.", 503);
  }
  if (!env.RESEND_API_KEY) {
    console.error("sign-in attempted but RESEND_API_KEY is unset");
    return bad("Sign-in isn't set up yet. Please email aswin@aswincloud.com.", 503);
  }

  if (!(await allowSend(env, email))) {
    console.warn("otp send throttled for", email);
    return ok();                                  // silent: no oracle
  }

  const code = generateOtp();                     // 6 digits, crypto-random
  const codeHash = await hashOtp(code, pepper(env));
  // expires_at is epoch SECONDS here — the package's convention for this table.
  await upsertOtp(env.DB, email, codeHash, Math.floor(now() / 1000) + OTP_TTL_SECONDS);

  const tpl = otpEmail({
    code,
    ttlMinutes: Math.round(OTP_TTL_SECONDS / 60),
    appName: env.APP_NAME || "AswinPrints",
  });

  // Sent in the background: a slow Resend call shouldn't hold the response, and
  // the outcome mustn't change what the caller sees anyway.
  ctx.waitUntil(sendEmail(env, {
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  }).then((r) => {
    if (!r.ok) console.error("otp email failed", r.status, r.error);
  }));

  return ok();
}

// ── POST /api/auth/code/verify ────────────────────────────────────
export async function verifyCode(request, env, body) {
  const email = normEmail(body?.email);
  const code = clip(body?.code, 12).replace(/\s+/g, "");

  if (!isEmail(email) || !code) return bad("Enter the code we emailed you.", 400);
  if (!accountsConfigured(env)) return bad("Sign-in isn't set up yet.", 503);

  const row = await getOtp(env.DB, email);
  // Same message for "no code was requested" and "wrong code", so this endpoint
  // can't be used to enumerate addresses either.
  const reject = () => bad("That code isn't right, or it's expired. Try again.", 400);
  if (!row) return reject();

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await deleteOtp(env.DB, email);
    return bad("Too many attempts. Please request a new code.", 429);
  }

  // expires_at is epoch seconds (package convention for otp_codes).
  if (row.expires_at < Math.floor(now() / 1000)) {
    await deleteOtp(env.DB, email);
    return reject();
  }

  const given = await hashOtp(code, pepper(env));
  if (!otpHashEquals(given, row.code_hash)) {
    await incrementOtpAttempts(env.DB, email);
    return reject();
  }

  // Correct: burn the code immediately so it can't be replayed.
  await deleteOtp(env.DB, email);

  // Find or create the account.
  let user = await env.DB.prepare(
    `SELECT id, email, name FROM users WHERE email = ?`
  ).bind(email).first();

  let isNew = false;
  if (!user) {
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO users (id, email, created_at, last_seen) VALUES (?,?,?,?)`
    ).bind(id, email, now(), now()).run();
    user = { id, email, name: null };
    isNew = true;
  } else {
    await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`)
      .bind(now(), user.id).run();
  }

  // Claim guest orders placed with this address.
  //
  // Safe because the code just proved control of the mailbox the order was
  // placed with. Only touches rows with user_id IS NULL, so an order already
  // attached to another account can never be stolen by re-registering an email.
  const claimed = await env.DB.prepare(
    `UPDATE orders SET user_id = ?
      WHERE user_id IS NULL AND lower(cust_email) = ?`
  ).bind(user.id, email).run();

  const token = await setSession(user.id, env);
  return json(
    {
      ok: true,
      email: user.email,
      name: user.name,
      is_new: isNew,
      claimed_orders: claimed.meta?.changes || 0,
    },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

// ── POST /api/auth/code/resend ────────────────────────────────────
// Distinct from requestCode only in enforcing the package's 60s cooldown, so a
// user mashing "resend" doesn't consume their hourly allowance in ten seconds.
export async function resendCode(request, env, ctx, body) {
  const email = normEmail(body?.email);
  if (!isEmail(email)) return bad("Please enter a valid email address.", 400);
  if (!accountsConfigured(env)) return bad("Sign-in isn't set up yet.", 503);

  const existing = await getOtp(env.DB, email);
  if (existing) {
    const ageSeconds = Math.floor(now() / 1000) - existing.created_at;
    if (ageSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      return json({
        ok: true,
        cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS - ageSeconds,
      });
    }
  }
  return requestCode(request, env, ctx, body);
}

// ── GET /api/me ───────────────────────────────────────────────────
// `is_admin` is a DISPLAY hint so the account page can offer a dashboard link.
// It grants nothing: /api/admin/* calls currentAdmin() and re-checks the
// allowlist itself, so a client that fakes this flag still gets 401.
export async function whoami(env, user, isAdmin = false) {
  // Explicitly uncacheable.
  //
  // This returns one customer's name, email, phone and delivery address. It has
  // never carried a Cache-Control header, which means "do not store" by default
  // — but with Workers Cache now enabled ([cache] in wrangler.toml), relying on
  // a default for a response like this is the wrong way round. State it.
  //
  // `private` alone would be enough for a shared cache; no-store is belt and
  // braces and costs nothing on a route that must never be reused.
  return json({
    signedIn: true,
    email: user.email,
    name: user.name || null,
    is_admin: Boolean(isAdmin),
    // The saved delivery details, so checkout can prefill without a second
    // round trip. Only ever the signed-in user's own row — `user` comes from the
    // verified session cookie, never from anything in the request.
    phone: user.phone || null,
    addr_line: user.addr_line || null,
    addr_city: user.addr_city || null,
    addr_state: user.addr_state || null,
    addr_pin: user.addr_pin || null,

    // ── the two things live chat needs ──
    //
    // Both derived from the verified session and issued to nobody else. A signed
    // -out caller gets `{signedIn:false}` from the gate in index.js and never
    // reaches this object at all.

    // What Chatwoot's identity validation checks. Without it, setUser() is a
    // claim anyone can make from the browser console — which was harmless while
    // the bot could look nothing up, and stops being harmless the moment it can.
    ...(env?.CHATWOOT_HMAC_SECRET
      ? { chat_identity_hash: await hmacHex(user.email, env.CHATWOOT_HMAC_SECRET) }
      : {}),

    // Proof of WHICH customer, for the bot's order lookup. Deliberately not the
    // Chatwoot contact's email: that record is populated from the browser, so
    // trusting it would put the customer list behind a dashboard toggle being set
    // correctly. This is the shop's own signed statement about its own session,
    // purpose-bound exactly like the session cookies in auth.js — a token minted
    // for anything else cannot be replayed here.
    //
    // Fifteen minutes. It only has to survive being handed to the widget, and the
    // widget re-reads /api/me on every page load.
    ...(env?.SESSION_SECRET
      ? { chat_token: await signToken(env.SESSION_SECRET, user.id, "chat_lookup", 900) }
      : {}),
  }, 200, { "cache-control": "private, no-store" });
}

export function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", { del: true }) });
}

// ── GET /api/me/orders ────────────────────────────────────────────
// INVARIANT 8: scoped by `user.id` from the verified session and nothing else.
// This function takes no url/query argument at all — not "ignores" one, but has
// no way to receive one. An id, email or receipt parameter here would be an IDOR
// exposing another customer's address and Razorpay payment id.
export async function myOrders(env, user) {
  const { results: orders } = await env.DB.prepare(
    `SELECT id, receipt, status, subtotal_paise, shipping_paise, total_paise,
            delivery, notes, created_at, paid_at, shipped_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(user.id).all();

  const list = orders || [];
  let items = [];
  if (list.length) {
    const ph = list.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT order_id, name, price_paise, qty FROM order_items
        WHERE order_id IN (${ph}) ORDER BY pos`
    ).bind(...list.map((o) => o.id)).all();
    items = r.results || [];
  }

  const byOrder = new Map();
  for (const it of items) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push({ name: it.name, price_paise: it.price_paise, qty: it.qty });
  }

  // `id` is dropped from the response: it's the internal uuid, the receipt is
  // the customer-facing handle, and nothing in the account UI needs it.
  return json({
    orders: list.map(({ id, ...o }) => ({ ...o, items: byOrder.get(id) || [] })),
  });
}

// ── PATCH /api/me ─────────────────────────────────────────────────
// Account settings. PATCH semantics like updateProduct: only the fields present
// in the body are touched, so the settings form can save just an address without
// clearing a name it never showed.
//
// Every field is optional and blank is meaningful — clearing a saved address has
// to be possible, so "" stores NULL rather than being ignored.
const PROFILE_FIELDS = {
  name: 80,
  phone: 30,
  addr_line: 200,
  addr_city: 80,
  addr_state: 80,
  addr_pin: 10,
};

export async function updateMe(env, user, body) {
  const sets = [];
  const args = [];
  const out = {};

  for (const [col, max] of Object.entries(PROFILE_FIELDS)) {
    if (!(col in (body || {}))) continue;
    const v = clip(body[col], max);
    // Validated, not just clipped: a saved PIN that is not six digits would
    // prefill checkout with something its own validation then rejects, which
    // reads as the site being broken rather than the data being wrong.
    if (col === "addr_pin" && v && !/^\d{6}$/.test(v)) {
      return bad("PIN code must be 6 digits.");
    }
    if (col === "phone" && v && v.replace(/\D/g, "").length < 10) {
      return bad("Please enter a valid phone number.");
    }
    sets.push(`${col} = ?`);
    args.push(v || null);
    out[col] = v || null;
  }

  if (!sets.length) return bad("Nothing to update.");

  args.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  return json({ ok: true, ...out });
}
