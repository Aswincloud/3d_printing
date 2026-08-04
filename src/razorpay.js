// Razorpay REST client + signature verification.
//
// No `razorpay` npm SDK: it does `require("crypto")` and ships axios's Node
// HTTP adapter, so it fails to bundle for a Worker without `nodejs_compat`
// (verified — `wrangler deploy --dry-run` errors with `Could not resolve
// "crypto"`). The REST API is three endpoints; fetch + WebCrypto covers it.

import { hmacHex, timingSafeEqualHex } from "./lib.js";

const API = "https://api.razorpay.com/v1";

// Razorpay authenticates with HTTP Basic: key_id as user, key_secret as pass.
// btoa is fine here — no Buffer without nodejs_compat.
function authHeader(env) {
  return "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
}

// Feature-flag by secret presence, the way invoicer does. A missing key
// disables checkout with a clear message instead of 500-ing at the API call.
export function paymentsConfigured(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

// Only the key *id* is public. Never expose KEY_SECRET.
export const publicKeyId = (env) => env.RAZORPAY_KEY_ID || "";

// ── orders ────────────────────────────────────────────────────────
// `amountPaise` is computed server-side by priceCart(). Nothing the browser
// sends reaches this function.
export async function createOrder(env, { amountPaise, receipt, notes }) {
  // Razorpay's own floor. Ours is higher in practice (cheapest product is
  // ₹349) but the API rejects <100 outright, so fail before the round-trip.
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    return { ok: false, status: 400, error: "Amount must be at least ₹1." };
  }

  const r = await fetch(`${API}/orders`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: String(receipt).slice(0, 40), // Razorpay caps receipt at 40 chars
      notes: notes || {},
    }),
  });

  const body = await r.json().catch(() => ({}));

  if (!r.ok) {
    // 401 means the keys are wrong — worth distinguishing in logs, since it's
    // a config error rather than anything the customer did.
    const desc = body?.error?.description || "";
    return { ok: false, status: r.status, error: desc, body };
  }
  return { ok: true, order: body };
}

export async function fetchPayment(env, paymentId) {
  const r = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader(env) },
  });
  const body = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, payment: body } : { ok: false, status: r.status, body };
}

// Partial refunds: omit amountPaise for a full refund.
export async function refundPayment(env, paymentId, amountPaise) {
  const r = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(amountPaise ? { amount: amountPaise } : {}),
  });
  const body = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, refund: body } : { ok: false, status: r.status, body };
}

// ── signatures ────────────────────────────────────────────────────
// TWO DIFFERENT SECRETS, and mixing them up is the classic Razorpay bug:
//
//   checkout callback → HMAC(order_id|payment_id, KEY_SECRET)
//   webhook           → HMAC(raw_request_body,    WEBHOOK_SECRET)
//
// KEY_SECRET is the API password. WEBHOOK_SECRET is a separate string you type
// into the dashboard when creating the webhook. They are never the same value.

export async function verifyCallbackSignature(env, { orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = await hmacHex(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET);
  return timingSafeEqualHex(expected, signature);
}

// `rawBody` must be the exact bytes received — see the note in the webhook
// handler. Re-serialising parsed JSON changes them and verification fails.
export async function verifyWebhookSignature(env, rawBody, signature) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = await hmacHex(rawBody, secret);
  return timingSafeEqualHex(expected, signature);
}
