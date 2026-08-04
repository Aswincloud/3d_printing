// Offline tests for the payment path. No network, no wrangler, no D1 —
// env.DB and globalThis.fetch are faked.
//
// The signature fixtures below were generated INDEPENDENTLY with openssl, not
// by the code under test:
//   printf '%s' "<msg>" | openssl dgst -sha256 -hmac "<secret>" -hex
// A test that signs with the same function it verifies with proves only
// self-consistency, which is exactly the bug class that lets a broken HMAC
// through.

import {
  verifyCallbackSignature, verifyWebhookSignature,
  paymentsConfigured, publicKeyId, createOrder,
} from "../src/razorpay.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

// A throwaway value used only to generate the fixtures below. Deliberately
// NOT the project's real key secret — a test file is committed, and a real
// credential in git history is a credential that has to be rotated.
const KEY_SECRET = "fixture_only_not_a_real_secret";
const WEBHOOK_SECRET = "whsec_test_fixture";
const ENV = {
  RAZORPAY_KEY_ID: "rzp_test_fixtureonly",
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const ORDER_ID = "order_TESTABC123";
const PAYMENT_ID = "pay_TESTXYZ789";
// openssl: printf '%s' "order_TESTABC123|pay_TESTXYZ789" \
//   | openssl dgst -sha256 -hmac "fixture_only_not_a_real_secret" -hex
const CALLBACK_SIG = "51f58b13547816164c0997a7fad9ecb0234cd333e0f64a4da797123e77d9b099";

// ── callback signature ────────────────────────────────────────────
section("verifyCallbackSignature() — fixture from openssl");
{
  const good = await verifyCallbackSignature(ENV, {
    orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: CALLBACK_SIG,
  });
  ok("accepts the openssl-computed signature", good === true);

  // One flipped hex char must fail.
  const flipped = CALLBACK_SIG.slice(0, -1) + (CALLBACK_SIG.endsWith("a") ? "b" : "a");
  ok("rejects a one-character change",
     (await verifyCallbackSignature(ENV, { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: flipped })) === false);

  // Swapping the two ids changes the message, so the same signature must fail.
  ok("rejects swapped order/payment ids",
     (await verifyCallbackSignature(ENV, { orderId: PAYMENT_ID, paymentId: ORDER_ID, signature: CALLBACK_SIG })) === false);

  ok("rejects a different order id",
     (await verifyCallbackSignature(ENV, { orderId: "order_OTHER", paymentId: PAYMENT_ID, signature: CALLBACK_SIG })) === false);
  ok("rejects a different payment id",
     (await verifyCallbackSignature(ENV, { orderId: ORDER_ID, paymentId: "pay_OTHER", signature: CALLBACK_SIG })) === false);

  // The wrong secret is the whole point of invariant 2.
  const wrongSecret = { ...ENV, RAZORPAY_KEY_SECRET: WEBHOOK_SECRET };
  ok("rejects when signed with WEBHOOK_SECRET instead of KEY_SECRET",
     (await verifyCallbackSignature(wrongSecret, { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: CALLBACK_SIG })) === false);

  ok("uppercase signature rejected (Razorpay sends lowercase)",
     (await verifyCallbackSignature(ENV, { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: CALLBACK_SIG.toUpperCase() })) === false);
}

section("verifyCallbackSignature() — missing input");
for (const [label, args] of [
  ["no signature", { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: "" }],
  ["no order id", { orderId: "", paymentId: PAYMENT_ID, signature: CALLBACK_SIG }],
  ["no payment id", { orderId: ORDER_ID, paymentId: "", signature: CALLBACK_SIG }],
  ["all empty", { orderId: "", paymentId: "", signature: "" }],
  ["undefined fields", {}],
  ["null signature", { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: null }],
]) {
  ok(`${label} → false`, (await verifyCallbackSignature(ENV, args)) === false);
}

// ── webhook signature ─────────────────────────────────────────────
section("verifyWebhookSignature() — raw body (invariant 3)");
{
  const RAW = '{"event":"order.paid","payload":{"order":{"entity":{"id":"order_TESTABC123"}}}}';
  // openssl: printf '%s' '<RAW>' | openssl dgst -sha256 -hmac "whsec_test_fixture" -hex
  const SIG = "abd17e3fba3a5e985deeae3003fa36f0b95ebb1f9052e7e3f2a81fd147b822c1";

  ok("accepts the openssl-computed signature",
     (await verifyWebhookSignature(ENV, RAW, SIG)) === true);

  // The invariant: HMAC must cover the received bytes. A pretty-printed body
  // that parses to the same object must NOT verify against the compact one.
  const pretty = JSON.stringify(JSON.parse(RAW), null, 2);
  ok("re-serialised body fails against the raw signature",
     (await verifyWebhookSignature(ENV, pretty, SIG)) === false);
  ok("fixture actually differs after pretty-printing", pretty !== RAW);

  // Key reordering is the other way this breaks.
  const reordered = '{"payload":{"order":{"entity":{"id":"order_TESTABC123"}}},"event":"order.paid"}';
  ok("reordered keys fail", (await verifyWebhookSignature(ENV, reordered, SIG)) === false);

  ok("trailing newline fails", (await verifyWebhookSignature(ENV, RAW + "\n", SIG)) === false);
  ok("empty body fails", (await verifyWebhookSignature(ENV, "", SIG)) === false);
  ok("missing signature fails", (await verifyWebhookSignature(ENV, RAW, "")) === false);

  // The other half of invariant 2, from the webhook side.
  const swapped = { ...ENV, RAZORPAY_WEBHOOK_SECRET: KEY_SECRET };
  ok("rejects when signed with KEY_SECRET instead of WEBHOOK_SECRET",
     (await verifyWebhookSignature(swapped, RAW, SIG)) === false);

  // A missing webhook secret must fail closed, never accept everything.
  const noSecret = { ...ENV, RAZORPAY_WEBHOOK_SECRET: "" };
  ok("missing WEBHOOK_SECRET fails closed",
     (await verifyWebhookSignature(noSecret, RAW, SIG)) === false);
  ok("missing WEBHOOK_SECRET rejects even an empty signature",
     (await verifyWebhookSignature(noSecret, RAW, "")) === false);
}

// ── the two secrets are genuinely different ───────────────────────
section("KEY_SECRET ≠ WEBHOOK_SECRET (invariant 2)");
{
  const msg = "order_X|pay_Y";
  const a = await verifyCallbackSignature(ENV, {
    orderId: "order_X", paymentId: "pay_Y",
    // sign with the webhook secret, verify as a callback → must fail
    signature: await (await import("../src/lib.js")).hmacHex(msg, WEBHOOK_SECRET),
  });
  ok("a webhook-signed callback is rejected", a === false);

  const b = await verifyCallbackSignature(ENV, {
    orderId: "order_X", paymentId: "pay_Y",
    signature: await (await import("../src/lib.js")).hmacHex(msg, KEY_SECRET),
  });
  ok("a key-signed callback is accepted", b === true);
}

// ── config flags ──────────────────────────────────────────────────
section("paymentsConfigured()");
ok("true with both keys", paymentsConfigured(ENV) === true);
ok("false with no key id", paymentsConfigured({ ...ENV, RAZORPAY_KEY_ID: "" }) === false);
ok("false with no secret", paymentsConfigured({ ...ENV, RAZORPAY_KEY_SECRET: "" }) === false);
ok("false with neither", paymentsConfigured({}) === false);

section("publicKeyId()");
ok("returns the key id", publicKeyId(ENV) === "rzp_test_fixtureonly");
ok("empty when unset", publicKeyId({}) === "");
// The single most important assertion in this file.
ok("NEVER returns the secret", !publicKeyId(ENV).includes(KEY_SECRET));

// ── createOrder ───────────────────────────────────────────────────
section("createOrder() — request shape");
{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "order_FAKE", amount: 99700, status: "created" }),
      { status: 200, headers: { "content-type": "application/json" } });
  };

  const r = await createOrder(ENV, { amountPaise: 99700, receipt: "AP-1a2b3c4d", notes: { order_id: "u-1" } });
  ok("returns ok", r.ok === true, JSON.stringify(r));
  ok("returns the razorpay order", r.order.id === "order_FAKE");

  const { url, init } = calls[0];
  ok("posts to the orders endpoint", url === "https://api.razorpay.com/v1/orders", url);
  ok("uses POST", init.method === "POST");

  const sent = JSON.parse(init.body);
  ok("sends the amount in paise", sent.amount === 99700);
  ok("amount is an integer", Number.isInteger(sent.amount));
  ok("currency INR", sent.currency === "INR");
  ok("sends the receipt", sent.receipt === "AP-1a2b3c4d");
  ok("receipt within Razorpay's 40-char cap", sent.receipt.length <= 40);
  ok("passes notes through", sent.notes.order_id === "u-1");

  // Basic auth, and the secret must be in the header — never the body or URL.
  const auth = init.headers.Authorization;
  ok("uses HTTP Basic", auth.startsWith("Basic "));
  ok("basic auth decodes to key_id:key_secret",
     atob(auth.slice(6)) === `${ENV.RAZORPAY_KEY_ID}:${KEY_SECRET}`);
  ok("secret is NOT in the request body", !init.body.includes(KEY_SECRET));
  ok("secret is NOT in the url", !url.includes(KEY_SECRET));
}

section("createOrder() — long receipt is truncated");
{
  let sentReceipt = null;
  globalThis.fetch = async (url, init) => {
    sentReceipt = JSON.parse(init.body).receipt;
    return new Response(JSON.stringify({ id: "order_X" }), { status: 200 });
  };
  await createOrder(ENV, { amountPaise: 50000, receipt: "A".repeat(120) });
  ok("receipt clipped to 40 chars", sentReceipt.length === 40, String(sentReceipt.length));
}

section("createOrder() — amount validation");
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };

  for (const [label, amt] of [
    ["99 paise", 99], ["zero", 0], ["negative", -100],
    ["fractional", 100.5], ["NaN", NaN], ["string", "500"],
    ["undefined", undefined], ["null", null], ["Infinity", Infinity],
  ]) {
    called = false;
    const r = await createOrder(ENV, { amountPaise: amt, receipt: "AP-x" });
    ok(`${label} rejected`, r.ok === false && r.status === 400, JSON.stringify(r));
    ok(`${label} makes no API call`, called === false);
  }

  called = false;
  const r = await createOrder(ENV, { amountPaise: 100, receipt: "AP-x" });
  ok("exactly 100 paise is allowed", called === true && r.ok !== false);
}

section("createOrder() — API errors");
{
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }),
    { status: 401, headers: { "content-type": "application/json" } });
  const r = await createOrder(ENV, { amountPaise: 50000, receipt: "AP-x" });
  ok("401 surfaces as not-ok", r.ok === false);
  ok("401 status preserved for logging", r.status === 401);
  ok("description captured", r.error === "Authentication failed");
}
{
  globalThis.fetch = async () => new Response("upstream exploded", { status: 500 });
  const r = await createOrder(ENV, { amountPaise: 50000, receipt: "AP-x" });
  ok("500 surfaces as not-ok", r.ok === false);
  ok("non-JSON error body doesn't throw", r.status === 500);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
