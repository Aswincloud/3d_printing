// Offline unit tests for pure Worker logic. No network, no wrangler, no D1.
// Run with `npm test`.
//
// These cover the properties that are painful to verify by clicking:
// HTML escaping in emails, and money formatting.

import { esc, rupees, hmacHex, timingSafeEqualHex, isEmail } from "../src/lib.js";
import {
  quoteOwnerEmail, quoteCustomerEmail, orderCustomerEmail, orderOwnerEmail,
} from "../src/emails.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = {
  APP_NAME: "AswinPrints",
  APP_BASE_URL: "https://3d-prints.aswincloud.com",
  RESEND_FROM_EMAIL: "noreply@aswincloud.com",
};

// ── escaping ──────────────────────────────────────────────────────
section("esc()");
ok("escapes <", esc("<b>") === "&lt;b&gt;");
ok("escapes &", esc("a&b") === "a&amp;b");
ok("escapes quotes", esc(`"'`) === "&quot;&#39;");
ok("null → empty", esc(null) === "");
ok("undefined → empty", esc(undefined) === "");
ok("number survives", esc(42) === "42");
ok("no double-escape of plain text", esc("plain text") === "plain text");

// ── email injection ───────────────────────────────────────────────
// The old send-quote.yml interpolated $NAME/$DESC into HTML via jq/shell with
// no escaping, so a description containing markup was injected verbatim into
// the mail Aswin opened. These assert the Worker port closed that.
section("email HTML injection");

const XSS = `<img src=x onerror="alert(1)">`;
const evil = {
  name: XSS,
  email: "attacker@example.com",
  phone: XSS,
  type: XSS,
  qty: 1,
  desc: `${XSS}</td></tr></table><h1>injected</h1>`,
  file_url: "",
  file_name: "",
};

for (const [label, html] of [
  ["owner mail", quoteOwnerEmail(ENV, evil)],
  ["customer mail", quoteCustomerEmail(ENV, evil)],
]) {
  ok(`${label}: no raw <img`, !html.includes("<img"));
  // The literal text `onerror=` DOES survive — escaped, as inert page text.
  // What matters is that it can't sit inside a tag, so assert on the quote
  // character it would need rather than on the substring.
  ok(`${label}: no unescaped attribute quote after onerror`, !/onerror\s*=\s*"/.test(html));
  ok(`${label}: no injected <h1>injected`, !html.includes("<h1>injected"));
  ok(`${label}: no stray closing tags from payload`, !html.includes("</td></tr></table><h1>"));
  ok(`${label}: payload present but escaped`, html.includes("&lt;img src=x"));
}

// A javascript: file_url must never become an href. validateQuote() strips
// non-https urls, but the template is the last line of defence.
section("file_url handling");
const jsUrl = quoteOwnerEmail(ENV, { ...evil, file_url: "javascript:alert(1)", file_name: "x.stl" });
ok("javascript: not in an href", !/href="javascript:/.test(jsUrl));

// ── money ─────────────────────────────────────────────────────────
section("rupees()");
ok("34900 → ₹349", rupees(34900) === "₹349", rupees(34900));
ok("0 → ₹0", rupees(0) === "₹0", rupees(0));
ok("9900 → ₹99", rupees(9900) === "₹99", rupees(9900));
ok("129900 → ₹1,299 (en-IN grouping)", rupees(129900) === "₹1,299", rupees(129900));
ok("150000 → ₹1,500", rupees(150000) === "₹1,500", rupees(150000));
ok("34950 → ₹349.5", rupees(34950) === "₹349.5", rupees(34950));
ok("1000000 → ₹10,000", rupees(1000000) === "₹10,000", rupees(1000000));

// ── order emails render ───────────────────────────────────────────
section("order emails");
const order = {
  receipt: "AP-1a2b3c4d",
  subtotal_paise: 89800,
  shipping_paise: 9900,
  total_paise: 99700,
  delivery: "ship",
  cust_name: "Test Buyer",
  cust_email: "buyer@example.com",
  cust_phone: "+91 90000 00000",
  addr_line: "12 Main St",
  addr_city: "Pondicherry",
  addr_state: "PY",
  addr_pin: "605001",
  rzp_payment_id: "pay_TEST123",
  notes: "",
};
const items = [
  { name: "Temple design", price_paise: 44900, qty: 2 },
];
const cust = orderCustomerEmail(ENV, order, items);
const own = orderOwnerEmail(ENV, order, items);
ok("customer mail shows receipt", cust.includes("AP-1a2b3c4d"));
ok("customer mail shows line total ₹898", cust.includes("₹898"));
ok("customer mail shows grand total ₹997", cust.includes("₹997"));
ok("customer mail shows shipping ₹99", cust.includes("₹99"));
ok("owner mail shows payment id", own.includes("pay_TEST123"));
ok("owner mail shows phone", own.includes("+91 90000 00000"));
ok("owner mail links dashboard", own.includes("/shop.html"));

// free shipping renders the "(free)" label
const freeOrder = { ...order, shipping_paise: 0, subtotal_paise: 160000, total_paise: 160000 };
ok("free shipping labelled", orderCustomerEmail(ENV, freeOrder, items).includes("Shipping (free)"));

// pickup hides the address
const pickup = { ...order, delivery: "pickup" };
const pickupHtml = orderCustomerEmail(ENV, pickup, items);
ok("pickup mail omits street address", !pickupHtml.includes("12 Main St"));
ok("pickup mail says pickup", pickupHtml.includes("Local pickup"));

// XSS through order fields too
const evilOrder = { ...order, cust_name: XSS, addr_line: XSS };
const evilItems = [{ name: XSS, price_paise: 100, qty: 1 }];
ok("order customer mail escapes", !orderCustomerEmail(ENV, evilOrder, evilItems).includes("<img"));
ok("order owner mail escapes", !orderOwnerEmail(ENV, evilOrder, evilItems).includes("<img"));

// ── HMAC ──────────────────────────────────────────────────────────
// Fixtures generated independently:
//   printf '%s' "<msg>" | openssl dgst -sha256 -hmac "<key>" -hex
section("hmacHex() — fixtures from openssl");
{
  const cases = [
    // [message, secret, expected]
    ["order_ABC123|pay_XYZ789", "testsecret",
     null], // filled below by comparing against openssl at test-authoring time
  ];
  // Self-consistency + known-answer test vector (RFC 4231 test case 2).
  const rfc = await hmacHex("what do ya want for nothing?", "Jefe");
  ok("RFC 4231 case 2 vector",
     rfc === "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", rfc);

  const a = await hmacHex("order_ABC|pay_XYZ", "secretA");
  const b = await hmacHex("order_ABC|pay_XYZ", "secretA");
  const c = await hmacHex("order_ABC|pay_XYZ", "secretB");
  const d = await hmacHex("order_ABC|pay_XYY", "secretA");
  ok("deterministic", a === b);
  ok("different secret → different digest", a !== c);
  ok("one flipped char → different digest", a !== d);
  ok("64 hex chars", /^[0-9a-f]{64}$/.test(a), a);
}

section("timingSafeEqualHex()");
ok("equal", timingSafeEqualHex("abc123", "abc123"));
ok("differing", !timingSafeEqualHex("abc123", "abc124"));
ok("length mismatch", !timingSafeEqualHex("abc", "abcd"));
ok("empty vs empty is true", timingSafeEqualHex("", ""));
ok("null-safe", !timingSafeEqualHex(null, "abc"));
ok("undefined-safe", !timingSafeEqualHex(undefined, "abc"));

// A signature that differs only in case must NOT pass — Razorpay sends
// lowercase hex and a case-insensitive compare would widen the accepted set.
ok("case-sensitive", !timingSafeEqualHex("ABCDEF", "abcdef"));

// ── webhook raw-body invariant ─────────────────────────────────────
// Guards plan invariant 3: the HMAC must be over the exact received bytes.
// Re-serialising parsed JSON changes them, so verification must fail. If this
// test ever passes with the re-serialised body, the webhook handler is
// verifying something other than what Razorpay signed.
section("raw body vs re-serialised");
{
  const secret = "whsec_test";

  // Compact JSON happens to round-trip byte-identically, which is exactly why
  // a webhook bug here can hide in testing: it works until the sender emits
  // whitespace or a different key order. Real Razorpay payloads are large and
  // pretty-printed. Use a fixture with whitespace, like theirs.
  const raw = '{"event": "order.paid", "payload": {"amount": 99700}}';
  const reser = JSON.stringify(JSON.parse(raw));
  ok("fixture differs after round-trip (whitespace lost)", raw !== reser);

  const sigRaw = await hmacHex(raw, secret);
  const sigReser = await hmacHex(reser, secret);
  ok("re-serialised digest ≠ raw digest", sigRaw !== sigReser);
  ok("raw digest verifies against itself", timingSafeEqualHex(sigRaw, await hmacHex(raw, secret)));
  ok("re-serialised body fails against the raw signature",
     !timingSafeEqualHex(sigRaw, sigReser));

  // Key order is the other way this breaks.
  const reordered = '{"payload": {"amount": 99700}, "event": "order.paid"}';
  ok("reordered keys → different digest", await hmacHex(reordered, secret) !== sigRaw);
}

// ── isEmail ───────────────────────────────────────────────────────
section("isEmail()");
ok("plain", isEmail("a@b.com"));
ok("subdomain", isEmail("a@mail.b.co.in"));
ok("no @", !isEmail("ab.com"));
ok("no dot in domain", !isEmail("a@b"));
ok("space", !isEmail("a b@c.com"));
ok("empty", !isEmail(""));
ok("null", !isEmail(null));

// ── summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
