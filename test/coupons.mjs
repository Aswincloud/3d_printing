// Offline tests for promo codes.
//
// Coupons are the first thing in this project that REDUCES what a customer pays,
// so these sit alongside test/shop.mjs as the ones that matter most: a bug here
// either overcharges a customer or gives the shop away.
//
// The tampering block is the point of the whole file. Everything else is
// arithmetic.

import { applyCoupon, recordRedemption, normaliseCode, listCoupons } from "../src/coupons.js";
import { priceCart } from "../src/shop.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = { FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" };

const CATALOGUE = [
  { id: "p-small", name: "Kingfisher", price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant", price_paise: 89900, visible: 1 },
];

// A coupon with every column, so tests only override what they care about.
const COUPON = {
  id: "c-1", code: "SAVE10", kind: "percent", value: 10,
  min_order_paise: 0, max_discount_paise: null, expires_at: null,
  max_uses: null, uses: 0, once_per_customer: 0, active: 1,
};

// ── fake D1 ───────────────────────────────────────────────────────
// Dispatches on the statements coupons.js and shop.js actually issue, and throws
// on anything else — a changed query must not quietly turn a test green.
function makeDB({ coupons = [], redemptions = [], products = CATALOGUE } = {}) {
  const db = {
    coupons: coupons.map((c) => ({ ...c })),
    coupon_redemptions: redemptions.map((r) => ({ ...r })),
    products: products.map((p) => ({ ...p })),
  };

  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT id, name, price_paise FROM products")) {
      const want = new Set(a);
      return { results: db.products.filter((p) => p.visible === 1 && want.has(p.id)) };
    }
    // The full-column read used by applyCoupon. Must be matched BEFORE the
    // id-only form below, which is a prefix of nothing but reads similarly.
    if (s.startsWith("SELECT id, code, kind, value")) {
      // COLLATE NOCASE on the column: compare case-insensitively here too, or a
      // test proving lowercase works would pass against a fake that is stricter
      // than the real database.
      const c = db.coupons.find((x) => x.code.toUpperCase() === String(a[0]).toUpperCase());
      return { first: c || null };
    }
    if (s.startsWith("SELECT id FROM coupons WHERE code = ?")) {
      const c = db.coupons.find((x) => x.code.toUpperCase() === String(a[0]).toUpperCase());
      return { first: c ? { id: c.id } : null };
    }
    if (s.startsWith("SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND email = ?")) {
      const r = db.coupon_redemptions.find(
        (x) => x.coupon_id === a[0] && x.email.toLowerCase() === String(a[1]).toLowerCase(),
      );
      return { first: r ? { id: r.id } : null };
    }
    if (s.startsWith("INSERT OR IGNORE INTO coupon_redemptions")) {
      const [id, coupon_id, order_id, email, user_id, created_at] = a;
      // The UNIQUE index on order_id is what makes redelivery safe. Emulate it,
      // or the idempotency test passes for the wrong reason.
      if (db.coupon_redemptions.some((r) => r.order_id === order_id)) {
        return { meta: { changes: 0 } };
      }
      db.coupon_redemptions.push({ id, coupon_id, order_id, email, user_id, created_at });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE coupons SET uses = uses + 1")) {
      const c = db.coupons.find((x) => x.id === a[1]);
      if (c) c.uses += 1;
      return { meta: { changes: c ? 1 : 0 } };
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
const envWith = (opts) => ({ ...ENV, DB: makeDB(opts) });

// ── normalisation ─────────────────────────────────────────────────
section("normaliseCode()");
ok("upper-cases", normaliseCode("save10") === "SAVE10");
ok("strips spaces pasted from a caption", normaliseCode("SAVE 10") === "SAVE10");
ok("trims", normaliseCode("  save10  ") === "SAVE10");
ok("empty stays empty", normaliseCode("") === "");
ok("null-safe", normaliseCode(null) === "");

// ── each kind ─────────────────────────────────────────────────────
section("applyCoupon() — the three kinds");
{
  const env = envWith({ coupons: [COUPON] });
  const r = await applyCoupon(env, "SAVE10", 89900, "a@b.com");
  ok("percent computes", r.discount_paise === 9000, String(r.discount_paise));
  ok("percent is not free shipping", r.free_shipping === false);
}
{
  // Rounded UP to the rupee: 10% of 89900 is 8990 paise = ₹89.90, which would
  // make the total ₹908.10 in a shop where every price is a whole rupee. Ceil,
  // so the rounding favours the customer.
  const env = envWith({ coupons: [COUPON] });
  const r = await applyCoupon(env, "SAVE10", 89900, "a@b.com");
  ok("percent rounds up to a whole rupee", r.discount_paise % 100 === 0, String(r.discount_paise));
  ok("rounding favours the customer", r.discount_paise === 9000, "8990 would be floor");
}
{
  const env = envWith({ coupons: [{ ...COUPON, code: "FLAT100", kind: "fixed", value: 10000 }] });
  const r = await applyCoupon(env, "FLAT100", 89900, "a@b.com");
  ok("fixed takes its face value", r.discount_paise === 10000);
}
{
  const env = envWith({ coupons: [{ ...COUPON, code: "SHIP", kind: "shipping", value: 0 }] });
  const r = await applyCoupon(env, "SHIP", 89900, "a@b.com");
  ok("shipping discounts nothing off items", r.discount_paise === 0);
  ok("shipping flags free shipping", r.free_shipping === true);
}
{
  const env = envWith({ coupons: [{ ...COUPON, code: "HALF", value: 50, max_discount_paise: 5000 }] });
  const r = await applyCoupon(env, "HALF", 89900, "a@b.com");
  ok("percent respects its cap", r.discount_paise === 5000, String(r.discount_paise));
}

// ── clamping ──────────────────────────────────────────────────────
section("applyCoupon() — never produces a negative total");
{
  const env = envWith({ coupons: [{ ...COUPON, code: "BIG", kind: "fixed", value: 50000 }] });
  const r = await applyCoupon(env, "BIG", 29900, "a@b.com");
  ok("discount clamps to the subtotal", r.discount_paise === 29900, String(r.discount_paise));
  ok("never exceeds what is owed", r.discount_paise <= 29900);
}
{
  const env = envWith({ coupons: [{ ...COUPON, code: "ALL", value: 100 }] });
  const r = await applyCoupon(env, "ALL", 34900, "a@b.com");
  ok("100% is allowed and equals the subtotal", r.discount_paise === 34900);
}

// ── rejections ────────────────────────────────────────────────────
section("applyCoupon() — every rejection");
{
  const env = envWith({ coupons: [COUPON] });
  ok("unknown code", (await applyCoupon(env, "NOPE", 89900, "a@b.com")).error);
  ok("empty code", (await applyCoupon(env, "", 89900, "a@b.com")).error);
}
{
  const env = envWith({ coupons: [{ ...COUPON, active: 0 }] });
  const r = await applyCoupon(env, "SAVE10", 89900, "a@b.com");
  ok("inactive is rejected", !!r.error);
  // Deliberately identical to the unknown-code message: a distinct one would
  // confirm the code exists, making the public endpoint an enumeration oracle.
  const unknown = await applyCoupon(envWith({ coupons: [] }), "SAVE10", 89900, "a@b.com");
  ok("inactive is indistinguishable from unknown", r.error === unknown.error, `${r.error} vs ${unknown.error}`);
}
{
  const env = envWith({ coupons: [{ ...COUPON, expires_at: 1 }] });
  const r = await applyCoupon(env, "SAVE10", 89900, "a@b.com");
  ok("expired is rejected", /expired/i.test(r.error || ""), r.error);
}
{
  const env = envWith({ coupons: [{ ...COUPON, expires_at: Date.now() + 86400000 }] });
  ok("not-yet-expired is accepted", !(await applyCoupon(env, "SAVE10", 89900, "a@b.com")).error);
}
{
  const env = envWith({ coupons: [{ ...COUPON, max_uses: 5, uses: 5 }] });
  ok("exhausted is rejected", /claimed/i.test((await applyCoupon(env, "SAVE10", 89900, "a@b.com")).error || ""));
}
{
  const env = envWith({ coupons: [{ ...COUPON, max_uses: 5, uses: 4 }] });
  ok("one use left is accepted", !(await applyCoupon(env, "SAVE10", 89900, "a@b.com")).error);
}
{
  const env = envWith({ coupons: [{ ...COUPON, min_order_paise: 50000 }] });
  const r = await applyCoupon(env, "SAVE10", 34900, "a@b.com");
  ok("under the minimum is rejected", !!r.error);
  ok("and names the shortfall", /151/.test(r.error), r.error);
  ok("exactly at the minimum is accepted",
     !(await applyCoupon(envWith({ coupons: [{ ...COUPON, min_order_paise: 34900 }] }), "SAVE10", 34900, "a@b.com")).error);
}

// ── once per customer ─────────────────────────────────────────────
section("applyCoupon() — once per customer");
{
  const env = envWith({
    coupons: [{ ...COUPON, once_per_customer: 1 }],
    redemptions: [{ id: "r1", coupon_id: "c-1", order_id: "o1", email: "used@b.com" }],
  });
  ok("a prior redemption blocks it",
     /already used/i.test((await applyCoupon(env, "SAVE10", 89900, "used@b.com")).error || ""));
  ok("case-insensitive on email",
     /already used/i.test((await applyCoupon(env, "SAVE10", 89900, "USED@B.com")).error || ""));
  ok("a different email is fine", !(await applyCoupon(env, "SAVE10", 89900, "new@b.com")).error);
  ok("no email at all is rejected", !!(await applyCoupon(env, "SAVE10", 89900, "")).error);
}
{
  // Without the flag, the same email may reuse it.
  const env = envWith({
    coupons: [COUPON],
    redemptions: [{ id: "r1", coupon_id: "c-1", order_id: "o1", email: "used@b.com" }],
  });
  ok("unlimited codes ignore prior redemptions",
     !(await applyCoupon(env, "SAVE10", 89900, "used@b.com")).error);
}

// ── TAMPERING (the point of this file) ────────────────────────────
// Mirrors the price-tampering block in test/shop.mjs. The client sends a CODE;
// everything the code is worth comes from D1.
section("priceCart() — a client cannot dictate its own discount");
{
  const env = envWith({ coupons: [COUPON] });
  const r = await priceCart(env, [
    { product_id: "p-large", qty: 1, discount_paise: 80000, price_paise: 1 },
  ], "ship", "SAVE10", "a@b.com");
  ok("injected discount_paise ignored", r.discount_paise === 9000, String(r.discount_paise));
  ok("injected price_paise still ignored", r.subtotal_paise === 89900);
  ok("total is derived, not sent", r.total_paise === 89900 - 9000 + 9900, String(r.total_paise));
}
{
  // A forged coupon object in the body must not be consulted at all.
  const env = envWith({ coupons: [COUPON] });
  const r = await priceCart(env, [
    { product_id: "p-large", qty: 1, coupon: { kind: "percent", value: 99 }, free_shipping: true },
  ], "ship", "SAVE10", "a@b.com");
  ok("forged coupon object ignored", r.discount_paise === 9000, String(r.discount_paise));
  ok("forged free_shipping ignored", r.shipping_paise === 9900, String(r.shipping_paise));
}
{
  // An unknown code must FAIL the order, not be silently dropped — dropping it
  // would charge more than the customer was shown.
  const env = envWith({ coupons: [COUPON] });
  const r = await priceCart(env, [{ product_id: "p-large", qty: 1 }], "ship", "FAKE", "a@b.com");
  ok("an invalid code refuses the order", !!r.error, JSON.stringify(r));
  ok("and yields no amounts", r.total_paise === undefined);
}

// ── discount vs the free-shipping threshold ───────────────────────
// The deliberate choice: discount first, THEN decide shipping. Asserted
// explicitly so a refactor cannot silently flip it and start giving shipping away.
section("priceCart() — discount is applied before shipping is decided");
{
  // 3 × 69900 = 209700, over the 200000 threshold. 10% off → 188730, under it.
  const env = envWith({
    coupons: [COUPON],
    products: [{ id: "p-x", name: "X", price_paise: 69900, visible: 1 }],
  });
  const r = await priceCart(env, [{ product_id: "p-x", qty: 3 }], "ship", "SAVE10", "a@b.com");
  ok("subtotal clears the threshold", r.subtotal_paise === 209700, String(r.subtotal_paise));
  ok("after the discount it does not", r.subtotal_paise - r.discount_paise < 200000);
  ok("so shipping IS charged", r.shipping_paise === 9900, String(r.shipping_paise));
  ok("total adds up", r.total_paise === r.subtotal_paise - r.discount_paise + r.shipping_paise);
}
{
  // Still over the threshold after the discount → free shipping, as normal.
  const env = envWith({
    coupons: [COUPON],
    products: [{ id: "p-x", name: "X", price_paise: 99900, visible: 1 }],
  });
  const r = await priceCart(env, [{ product_id: "p-x", qty: 3 }], "ship", "SAVE10", "a@b.com");
  ok("comfortably over the threshold still ships free", r.shipping_paise === 0, String(r.shipping_paise));
}
{
  // A free-shipping code waives it regardless of the threshold.
  const env = envWith({ coupons: [{ ...COUPON, code: "SHIP", kind: "shipping", value: 0 }] });
  const r = await priceCart(env, [{ product_id: "p-small", qty: 1 }], "ship", "SHIP", "a@b.com");
  ok("free-shipping code waives shipping", r.shipping_paise === 0);
  ok("and leaves the subtotal alone", r.total_paise === 34900, String(r.total_paise));
}
{
  // No code at all: unchanged behaviour, and the new fields are still present.
  const env = envWith({ coupons: [COUPON] });
  const r = await priceCart(env, [{ product_id: "p-small", qty: 1 }], "ship");
  ok("no coupon → no discount", r.discount_paise === 0);
  ok("no coupon → null code", r.coupon_code === null);
  ok("no coupon → shipping as before", r.shipping_paise === 9900);
}

// ── redemption counting ───────────────────────────────────────────
section("recordRedemption() — counts once, on payment");
{
  const env = envWith({ coupons: [COUPON] });
  await recordRedemption(env, { couponCode: "SAVE10", orderId: "o1", email: "a@b.com", userId: null });
  ok("uses incremented", env.DB._db.coupons[0].uses === 1, String(env.DB._db.coupons[0].uses));
  ok("redemption row written", env.DB._db.coupon_redemptions.length === 1);

  // THE assertion: Razorpay retries a webhook on any non-2xx, so a redelivery
  // must not count twice.
  await recordRedemption(env, { couponCode: "SAVE10", orderId: "o1", email: "a@b.com", userId: null });
  await recordRedemption(env, { couponCode: "SAVE10", orderId: "o1", email: "a@b.com", userId: null });
  ok("a redelivered webhook does NOT double-count", env.DB._db.coupons[0].uses === 1,
     String(env.DB._db.coupons[0].uses));
  ok("and writes no second row", env.DB._db.coupon_redemptions.length === 1);

  // A genuinely different order does count.
  await recordRedemption(env, { couponCode: "SAVE10", orderId: "o2", email: "c@d.com", userId: null });
  ok("a different order counts", env.DB._db.coupons[0].uses === 2);
}
{
  // Lower-cased code from an order snapshot must still find the coupon.
  const env = envWith({ coupons: [COUPON] });
  await recordRedemption(env, { couponCode: "save10", orderId: "o1", email: "a@b.com" });
  ok("normalises the stored code", env.DB._db.coupons[0].uses === 1);
}
{
  // The coupon was deleted between order and payment. Must not throw — the
  // customer has already paid and the order's snapshot is what matters.
  const env = envWith({ coupons: [] });
  let threw = false;
  try {
    await recordRedemption(env, { couponCode: "GONE", orderId: "o1", email: "a@b.com" });
  } catch { threw = true; }
  ok("a deleted coupon does not throw", !threw);
}

// ── what a code has cost ──────────────────────────────────────────
// `uses` says a code was redeemed; these say what that was worth. Aswin asked to
// see full details in the dashboard, and "37 redemptions" without "₹4,200 given
// away, ₹31,000 brought in" is not enough to decide whether to run it again.
section("listCoupons() — money aggregation");
{
  const coupons = [{
    id: "e1", code: "DIWALI20", kind: "percent", value: 20, min_order_paise: 100000,
    max_discount_paise: 50000, expires_at: null, max_uses: 100, uses: 2,
    once_per_customer: 1, active: 1, created_at: 1785000000000, updated_at: 1785000000000,
  }];
  const totals = [{
    coupon_code: "DIWALI20", orders: 2, discount_paise: 44000,
    revenue_paise: 235900, last_used: 1785910000000,
  }];
  const env = { DB: { prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return { bind() { return this; }, async all() {
      if (s.startsWith("SELECT id, code, kind, value")) return { results: coupons };
      if (s.startsWith("SELECT coupon_code,")) return { results: totals };
      throw new Error("unhandled SQL: " + s.slice(0, 60));
    } };
  } } };
  const body = await (await listCoupons(env)).json();
  const c = body.coupons[0];
  ok("counts paid orders", c.paid_orders === 2, String(c.paid_orders));
  ok("sums what was given away", c.given_away_paise === 44000, String(c.given_away_paise));
  ok("sums the revenue it brought in", c.revenue_paise === 235900, String(c.revenue_paise));
  ok("carries the last-used timestamp", c.last_used_at === 1785910000000);
  ok("original columns survive the merge", c.code === "DIWALI20" && c.max_uses === 100);
}
{
  // A coupon nobody has used must report zeroes, not undefined — the dashboard
  // branches on `paid_orders > 0` and undefined would render "undefined orders".
  const env = { DB: { prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return { bind() { return this; }, async all() {
      if (s.startsWith("SELECT id, code, kind, value")) {
        return { results: [{ id: "e2", code: "UNUSED", kind: "fixed", value: 10000, uses: 0 }] };
      }
      return { results: [] };
    } };
  } } };
  const c = (await (await listCoupons(env)).json()).coupons[0];
  ok("unused coupon reports zero orders", c.paid_orders === 0);
  ok("unused coupon reports zero given away", c.given_away_paise === 0);
  ok("unused coupon has a null last-used", c.last_used_at === null);
}
{
  // The join is case-insensitive: coupons.code is COLLATE NOCASE, but the
  // orders snapshot is a plain TEXT column, so a differently-cased snapshot must
  // still match or the totals would silently read zero.
  const env = { DB: { prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return { bind() { return this; }, async all() {
      if (s.startsWith("SELECT id, code, kind, value")) {
        return { results: [{ id: "e3", code: "SAVE10", kind: "percent", value: 10, uses: 1 }] };
      }
      return { results: [{ coupon_code: "save10", orders: 1, discount_paise: 5000,
                           revenue_paise: 50000, last_used: 1 }] };
    } };
  } } };
  const c = (await (await listCoupons(env)).json()).coupons[0];
  ok("matches a differently-cased snapshot", c.paid_orders === 1, String(c.paid_orders));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
