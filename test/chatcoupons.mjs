// Offline tests for chat-issued discount codes.
//
// This is the first feature where a STRANGER'S TEXT can reach money: a visitor
// types into a chat box, an LLM reads it, and a discount code comes out. The
// security argument is that the LLM decides nothing — every number comes from a
// constant in src/chatcoupons.js and the request carries only a visitor ref.
//
// So the tampering block is the point of this file, exactly as it is in
// test/coupons.mjs. Everything else is plumbing.

import { issueChatCoupon, chatCouponHandler, CHAT_COUPON } from "../src/chatcoupons.js";
import { applyCoupon } from "../src/coupons.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SECRET = "test-chat-secret-do-not-use-in-production";
const ENV = {
  FLAT_SHIP_PAISE: "9900",
  FREE_SHIP_THRESHOLD_PAISE: "200000",
  CHAT_COUPONS_ENABLED: "true",
  CHAT_BOT_SECRET: SECRET,
};

// ── fake D1 ───────────────────────────────────────────────────────
// Same discipline as test/coupons.mjs: dispatches on the statements the code
// actually issues and THROWS on anything else, so a changed query cannot quietly
// turn a test green.
function makeDB({ coupons = [] } = {}) {
  const db = { coupons: coupons.map((c) => ({ ...c })) };

  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();

    // issueChatCoupon: does this visitor already hold a live code?
    if (s.startsWith("SELECT code, expires_at FROM coupons WHERE issued_to = ?")) {
      const [ref, ts] = a;
      const hit = db.coupons
        .filter((c) => c.issued_to === ref && c.issued_by === "chat" && c.active === 1
                    && c.uses === 0 && c.expires_at > ts)
        .sort((x, y) => y.expires_at - x.expires_at)[0];
      return { first: hit ? { code: hit.code, expires_at: hit.expires_at } : null };
    }

    // The hourly blast-radius cap.
    if (s.startsWith("SELECT COUNT(*) AS n FROM coupons WHERE issued_by = 'chat'")) {
      const since = a[0];
      return { first: { n: db.coupons.filter((c) => c.issued_by === "chat" && c.created_at > since).length } };
    }

    if (s.startsWith("INSERT INTO coupons")) {
      const [id, code, value, min_order_paise, max_discount_paise,
             expires_at, max_uses, issued_to, created_at, updated_at] = a;
      // Emulate UNIQUE(code) COLLATE NOCASE — the retry loop is untestable
      // against a fake that accepts duplicates.
      if (db.coupons.some((c) => c.code.toUpperCase() === String(code).toUpperCase())) {
        throw new Error("UNIQUE constraint failed: coupons.code");
      }
      db.coupons.push({
        id, code, kind: "percent", value, min_order_paise, max_discount_paise,
        expires_at, max_uses, uses: 0, once_per_customer: 0, active: 1,
        issued_to, issued_by: "chat", created_at, updated_at,
      });
      return { meta: { changes: 1 } };
    }

    // applyCoupon's read, for the redemption-path tests below.
    if (s.startsWith("SELECT id, code, kind, value")) {
      const c = db.coupons.find((x) => x.code.toUpperCase() === String(a[0]).toUpperCase());
      return { first: c || null };
    }

    throw new Error("unhandled SQL in fake D1: " + s.slice(0, 90));
  };

  return {
    _db: db,
    prepare(sql) {
      return {
        bind(...args) { this._a = args; return this; },
        async all() { return { results: run(sql, this._a || []).results || [] }; },
        async first() { return run(sql, this._a || []).first ?? null; },
        async run() { return run(sql, this._a || []); },
      };
    },
  };
}
const envWith = (opts = {}, over = {}) => ({ ...ENV, ...over, DB: makeDB(opts) });

// Build a correctly-signed request, so each auth test can break exactly one thing.
async function signedRequest(bodyObj, { secret = SECRET, signature = null } = {}) {
  const raw = JSON.stringify(bodyObj);
  return new Request("https://x/api/chat/coupon", {
    method: "POST",
    body: raw,
    headers: { "x-chat-signature": signature ?? (await hmacHex(raw, secret)) },
  });
}

// ── the terms ─────────────────────────────────────────────────────
section("the minted code carries exactly the agreed terms");
{
  const env = envWith();
  const before = Date.now();
  const r = await issueChatCoupon(env, "contact-1");
  const row = env.DB._db.coupons[0];

  ok("code is issued", !r.error && typeof r.code === "string", r.error || "");
  ok("code is prefixed CHAT-", /^CHAT-[A-Z0-9]{6}$/.test(r.code), r.code);
  ok("stored as a percent coupon", row.kind === "percent");
  ok("10 percent", row.value === 10, String(row.value));
  ok("capped at ₹300", row.max_discount_paise === 30000, String(row.max_discount_paise));
  ok("no minimum order", row.min_order_paise === 0, String(row.min_order_paise));
  ok("single use", row.max_uses === 1, String(row.max_uses));
  ok("active", row.active === 1);
  ok("tagged as chat-issued", row.issued_by === "chat");
  ok("bound to the visitor", row.issued_to === "contact-1");

  const ttl = row.expires_at - before;
  ok("expires in ~30 minutes", ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000 + 2000, `${ttl}ms`);
}

// The alphabet exists so a human can retype the code off a phone screen.
section("code is readable");
{
  const env = envWith();
  const codes = [];
  for (let i = 0; i < 40; i++) {
    const r = await issueChatCoupon(env, `visitor-${i}`);
    codes.push(r.code);
  }
  const body = codes.map((c) => c.slice(5)).join("");
  ok("no ambiguous characters (O/0/I/1/S/5)", !/[O0I1S5]/.test(body));
  ok("all distinct", new Set(codes).size === codes.length);
}

// ── one code per visitor ──────────────────────────────────────────
section("a visitor cannot farm codes");
{
  const env = envWith();
  const a = await issueChatCoupon(env, "contact-7");
  const b = await issueChatCoupon(env, "contact-7");
  ok("asking twice returns the SAME code", a.code === b.code, `${a.code} vs ${b.code}`);
  ok("second call is flagged as reused", b.reused === true);
  ok("only one row was written", env.DB._db.coupons.length === 1, String(env.DB._db.coupons.length));

  const c = await issueChatCoupon(env, "contact-8");
  ok("a different visitor gets a different code", c.code !== a.code);
}
{
  // An EXPIRED code must not be handed back — otherwise a visitor who returns
  // tomorrow is given a dead code and told it is their discount.
  const env = envWith({
    coupons: [{
      id: "c-old", code: "CHAT-EXPIRD", kind: "percent", value: 10,
      min_order_paise: 0, max_discount_paise: 30000,
      expires_at: Date.now() - 1000, max_uses: 1, uses: 0,
      once_per_customer: 0, active: 1,
      issued_to: "contact-9", issued_by: "chat",
      created_at: Date.now() - 60 * 60 * 1000, updated_at: Date.now(),
    }],
  });
  const r = await issueChatCoupon(env, "contact-9");
  ok("an expired code is not reused", r.code !== "CHAT-EXPIRD", r.code);
  ok("a fresh one is minted instead", env.DB._db.coupons.length === 2);
}
{
  // Already spent: same reasoning. uses=1 on a max_uses=1 code is dead.
  const env = envWith({
    coupons: [{
      id: "c-used", code: "CHAT-USEDUP", kind: "percent", value: 10,
      min_order_paise: 0, max_discount_paise: 30000,
      expires_at: Date.now() + 10 * 60 * 1000, max_uses: 1, uses: 1,
      once_per_customer: 0, active: 1,
      issued_to: "contact-10", issued_by: "chat",
      created_at: Date.now(), updated_at: Date.now(),
    }],
  });
  const r = await issueChatCoupon(env, "contact-10");
  ok("a spent code is not reused", r.code !== "CHAT-USEDUP", r.code);
}

// ── the limits actually bite ──────────────────────────────────────
//
// Asserted through applyCoupon(), the real redemption path, rather than by
// re-reading the row. A row with the right columns that the checkout ignores
// would be worth nothing.
section("the limits bite at redemption");
{
  const env = envWith();
  const { code } = await issueChatCoupon(env, "contact-c");

  const small = await applyCoupon(env, code, 54900, "a@b.com");   // ₹549, the median
  ok("10% off a median cart", small.discount_paise === 5500, String(small.discount_paise));

  const big = await applyCoupon(env, code, 1200000, "a@b.com");   // ₹12,000, the top item
  ok("cap bites on the top product", big.discount_paise === 30000, String(big.discount_paise));
  ok("cap saves ₹900 vs uncapped", 120000 - big.discount_paise === 90000);
}
{
  // Expiry, through the real path.
  const env = envWith();
  const { code } = await issueChatCoupon(env, "contact-d");
  const row = env.DB._db.coupons[0];

  const live = await applyCoupon(env, code, 100000, "a@b.com");
  ok("valid before expiry", !live.error, live.error || "");

  row.expires_at = Date.now() - 1;   // 31 minutes later
  const dead = await applyCoupon(env, code, 100000, "a@b.com");
  ok("rejected after expiry", /expired/i.test(dead.error || ""), dead.error || "no error");
}
{
  // Single use, through the real path. This is the limit that stops one code
  // being posted to a deal forum.
  const env = envWith();
  const { code } = await issueChatCoupon(env, "contact-e");
  const row = env.DB._db.coupons[0];

  ok("first redemption works", !(await applyCoupon(env, code, 100000, "a@b.com")).error);
  row.uses = 1;
  const second = await applyCoupon(env, code, 100000, "other@b.com");
  ok("second redemption refused", /fully claimed/i.test(second.error || ""), second.error || "no error");
}

// ── blast radius ──────────────────────────────────────────────────
section("hourly mint cap");
{
  const env = envWith();
  for (let i = 0; i < 60; i++) await issueChatCoupon(env, `flood-${i}`);
  ok("60 mints succeed", env.DB._db.coupons.length === 60, String(env.DB._db.coupons.length));

  const over = await issueChatCoupon(env, "flood-61");
  ok("the 61st is refused", over.error === "unavailable", JSON.stringify(over));
  ok("and writes no row", env.DB._db.coupons.length === 60, String(env.DB._db.coupons.length));

  // A visitor who already holds a code must still get it during a flood: they
  // are not consuming a new one, and refusing them mid-conversation would be the
  // wrong thing to ration.
  const existing = await issueChatCoupon(env, "flood-3");
  ok("an existing holder is still served", !existing.error && existing.reused === true);
}

// ── auth ──────────────────────────────────────────────────────────
//
// Without this the endpoint is an open discount-code faucet on the public
// internet, so each failure mode is asserted separately.
section("HMAC auth");
{
  const env = envWith();
  const good = await chatCouponHandler(await signedRequest({ visitor_ref: "v1", ts: Date.now() }), env);
  ok("a correctly signed request is accepted", good.status === 200, String(good.status));
}
{
  const env = envWith();
  const req = new Request("https://x/api/chat/coupon", {
    method: "POST", body: JSON.stringify({ visitor_ref: "v1", ts: Date.now() }),
  });
  const r = await chatCouponHandler(req, env);
  ok("no signature → 401", r.status === 401, String(r.status));
  ok("and writes no row", env.DB._db.coupons.length === 0);
}
{
  const env = envWith();
  const r = await chatCouponHandler(
    await signedRequest({ visitor_ref: "v1", ts: Date.now() }, { secret: "the-wrong-secret" }), env);
  ok("wrong secret → 401", r.status === 401, String(r.status));
  ok("and writes no row", env.DB._db.coupons.length === 0);
}
{
  // Signature valid for a DIFFERENT body — the classic mistake of verifying a
  // signature but then acting on re-serialised or swapped content.
  const env = envWith();
  const honest = JSON.stringify({ visitor_ref: "v1", ts: Date.now() });
  const sig = await hmacHex(honest, SECRET);
  const tampered = JSON.stringify({ visitor_ref: "attacker", ts: Date.now() });
  const req = new Request("https://x/api/chat/coupon", {
    method: "POST", body: tampered, headers: { "x-chat-signature": sig },
  });
  const r = await chatCouponHandler(req, env);
  ok("body swapped after signing → 401", r.status === 401, String(r.status));
  ok("and writes no row", env.DB._db.coupons.length === 0);
}
{
  // Replay. The signature proves the body came from something holding the secret;
  // the timestamp proves it was recent. Without the window, one captured request
  // is a code generator forever.
  const env = envWith();
  const old = await chatCouponHandler(
    await signedRequest({ visitor_ref: "v1", ts: Date.now() - 10 * 60 * 1000 }), env);
  ok("a 10-minute-old request → 401", old.status === 401, String(old.status));

  const future = await chatCouponHandler(
    await signedRequest({ visitor_ref: "v1", ts: Date.now() + 10 * 60 * 1000 }), env);
  ok("a far-future timestamp → 401", future.status === 401, String(future.status));

  const drift = await chatCouponHandler(
    await signedRequest({ visitor_ref: "v1", ts: Date.now() - 60 * 1000 }), env);
  ok("ordinary clock drift is tolerated", drift.status === 200, String(drift.status));
}
{
  const env = envWith({}, { CHAT_BOT_SECRET: "" });
  const r = await chatCouponHandler(await signedRequest({ visitor_ref: "v1", ts: Date.now() }), env);
  ok("missing secret fails CLOSED", r.status === 503, String(r.status));
  ok("and writes no row", env.DB._db.coupons.length === 0);
}

// ── kill switch ───────────────────────────────────────────────────
section("kill switch");
{
  const env = envWith({}, { CHAT_COUPONS_ENABLED: "false" });
  const r = await chatCouponHandler(await signedRequest({ visitor_ref: "v1", ts: Date.now() }), env);
  ok("disabled → 503", r.status === 503, String(r.status));
  ok("and writes no row", env.DB._db.coupons.length === 0, String(env.DB._db.coupons.length));
}
{
  // Absent, not just "false". A missing var must not mean "on" — the flag is
  // opt-in so a fresh environment cannot start giving money away by omission.
  const env = envWith({}, { CHAT_COUPONS_ENABLED: undefined });
  const r = await chatCouponHandler(await signedRequest({ visitor_ref: "v1", ts: Date.now() }), env);
  ok("absent flag → 503 (opt-in, not opt-out)", r.status === 503, String(r.status));
}

// ── TAMPERING — the point of this file ────────────────────────────
//
// A visitor controls the text the LLM reads. If any of these moved the terms, a
// prompt injection would be a live attack on revenue.
section("the request body cannot move the terms");
{
  const env = envWith();
  const req = await signedRequest({
    visitor_ref: "attacker",
    ts: Date.now(),
    // Every shape a confused or compromised caller might send:
    percent: 90,
    value: 90,
    kind: "fixed",
    max_discount_paise: 99999999,
    min_order_paise: 0,
    expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000,
    max_uses: 10000,
    active: 1,
    discount_paise: 1200000,
  });
  const res = await chatCouponHandler(req, env);
  const row = env.DB._db.coupons[0];

  ok("a body full of overrides is still accepted", res.status === 200, String(res.status));
  ok("percent is still 10", row.value === 10, String(row.value));
  ok("kind is still percent", row.kind === "percent", row.kind);
  ok("cap is still ₹300", row.max_discount_paise === 30000, String(row.max_discount_paise));
  ok("still single-use", row.max_uses === 1, String(row.max_uses));
  ok("expiry is still 30 min, not a year",
     row.expires_at - Date.now() < 31 * 60 * 1000, String(row.expires_at - Date.now()));

  // And the real test: what it is worth at checkout.
  const worth = await applyCoupon(env, row.code, 1200000, "a@b.com");
  ok("worth ₹300 on a ₹12,000 cart, not ₹10,800",
     worth.discount_paise === 30000, String(worth.discount_paise));
}
{
  // A visitor ref is a string. Objects and arrays must not reach D1 as bind
  // params of the wrong type.
  const env = envWith();
  for (const bad of [{ nested: 1 }, [1, 2, 3], 12345, true]) {
    const res = await chatCouponHandler(
      await signedRequest({ visitor_ref: bad, ts: Date.now() }), env);
    ok(`visitor_ref ${JSON.stringify(bad)} is coerced or refused, never crashes`,
       res.status === 200 || res.status === 400, String(res.status));
  }
  const empty = await chatCouponHandler(await signedRequest({ ts: Date.now() }), env);
  ok("a missing visitor_ref is refused", empty.status === 400, String(empty.status));
}

// ── the constants are what the plan said ──────────────────────────
section("exported terms match the agreed decisions");
ok("10 percent", CHAT_COUPON.percent === 10);
ok("₹300 cap", CHAT_COUPON.cap_paise === 30000);
ok("no minimum", CHAT_COUPON.min_order_paise === 0);
ok("30 minutes", CHAT_COUPON.ttl_ms === 30 * 60 * 1000);
ok("single use", CHAT_COUPON.max_uses === 1);

console.log(`\n  chatcoupons: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
