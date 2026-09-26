// Promo codes.
//
// The security rule, and the reason every number here is read from D1:
//
//   The client sends a CODE. Nothing else about the discount comes from the
//   request. The percentage, the amount, the minimum, the expiry — all read
//   from the coupons table inside the same call that prices the cart.
//
// There is a live precedent for getting this wrong in this codebase. `delivery`
// used to be read from the request body, and shippingFor() returned 0 for
// "pickup", so a client could POST {delivery:"pickup"} and pay no shipping.
// Removing the radio from the form would NOT have closed it — hardcoding the
// value server-side did. A coupon field is the same shape of risk.

import { json, bad, uid, now } from "./lib.js";

const MAXLEN = { code: 40 };
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

export const KINDS = ["percent", "fixed", "shipping"];

// Codes are stored and compared upper-case with COLLATE NOCASE on the column, so
// the normalisation here is belt-and-braces: it also strips the spaces people
// paste in from a caption ("SAVE 10").
export const normaliseCode = (v) =>
  clip(v, MAXLEN.code).toUpperCase().replace(/\s+/g, "");

// Same contract as parsePaise in admin.js: null for invalid, 0 is valid.
// Callers must test `=== null`, never truthiness.
function parseInt0(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

const rupees = (paise) => "₹" + Math.round(paise / 100).toLocaleString("en-IN");

// ── the core ──────────────────────────────────────────────────────
//
// Returns { coupon, discount_paise, free_shipping } or { error }.
//
// `error` is customer-facing, so it says what to do about it where that helps
// ("Add ₹201 more") and stays vague where saying more would leak whether a code
// exists at all.
// Up to three product names, then "and N more". For the refusal a scoped code
// gives a cart that holds none of its products — the message has to say WHICH.
function listNames(names) {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const head = shown.length > 1 ? shown.slice(0, -1).join(", ") + " and " + shown.at(-1) : shown[0];
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : head;
}

// The products a code is limited to, with names for messages. Empty = the whole
// cart. One query, joined, so a product that no longer exists simply drops out.
export async function couponScope(env, couponId) {
  const { results } = await env.DB.prepare(
    `SELECT cp.product_id, p.name
       FROM coupon_products cp
       JOIN products p ON p.id = cp.product_id
      WHERE cp.coupon_id = ?
      ORDER BY p.name`
  ).bind(couponId).all();
  return results || [];
}

// `items` are priceCart()'s priced lines ({product_id, price_paise, qty}). They
// decide what a SCOPED code applies to; an unscoped code never looks at them.
// A scoped code with no items to look at is refused rather than widened to the
// whole cart — that is the one way the scope could silently stop mattering.
export async function applyCoupon(env, rawCode, subtotalPaise, email, items = null) {
  const code = normaliseCode(rawCode);
  if (!code) return { error: "Enter a promo code." };

  const c = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise,
            expires_at, max_uses, uses, once_per_customer, active
       FROM coupons WHERE code = ?`
  ).bind(code).first();

  // Unknown and deactivated give the SAME message on purpose. A distinct
  // "this code is no longer active" would confirm the code exists, which turns
  // this endpoint into an oracle for guessing real codes.
  if (!c || !c.active) return { error: "That promo code isn't valid." };

  if (c.expires_at && now() > c.expires_at) {
    return { error: "That promo code has expired." };
  }

  if (c.max_uses !== null && c.uses >= c.max_uses) {
    return { error: "That promo code has been fully claimed." };
  }

  if (subtotalPaise < c.min_order_paise) {
    const short = c.min_order_paise - subtotalPaise;
    return { error: `Add ${rupees(short)} more to use this code (minimum ${rupees(c.min_order_paise)}).` };
  }

  // ── product scope ──
  // The discount is computed on the ELIGIBLE lines only. `base` is the whole
  // subtotal for an unscoped code and the eligible items' subtotal for a scoped
  // one; everything below this point works on `base`, so no arithmetic branch
  // can accidentally reach for the whole cart.
  const scope = await couponScope(env, c.id);
  let base = subtotalPaise;
  let appliesTo = null;
  if (scope.length) {
    appliesTo = scope.map((s) => s.name);
    const eligible = new Set(scope.map((s) => s.product_id));
    // No lines passed (a caller that only knows the subtotal) reads as no
    // eligible lines, and is refused below — never widened to the whole cart.
    base = (Array.isArray(items) ? items : []).reduce((sum, it) =>
      sum + (eligible.has(it.product_id) ? Number(it.price_paise) * Number(it.qty) : 0), 0);
    if (base <= 0) {
      return { error: `That code only applies to ${listNames(appliesTo)}.` };
    }
  }

  // Once-per-customer, keyed on email — see the note in 0007_coupons.sql on why
  // email rather than user_id. Guests must be able to use codes.
  //
  // Only PAID orders create a redemption row, so an abandoned checkout does not
  // lock someone out of a code they never actually used.
  if (c.once_per_customer) {
    const mail = clip(email, 160);
    if (!mail) return { error: "Enter your email before applying this code." };
    const prior = await env.DB.prepare(
      `SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND email = ?`
    ).bind(c.id, mail).first();
    if (prior) return { error: "You've already used that promo code." };
  }

  // ── the arithmetic ──
  let discount = 0;
  let freeShipping = false;

  if (c.kind === "percent") {
    // Rounded UP to a whole rupee, not left at paise precision.
    //
    // 10% of ₹899 is ₹89.90, which makes the total ₹908.10. That is
    // arithmetically exact — every amount here is integer paise and Razorpay is
    // charged 100810 exactly — but every price in this shop is a whole rupee, so
    // a total ending in .10 reads as a bug to the customer and the paise are
    // unspendable in practice.
    //
    // Ceil rather than floor so the rounding favours the customer (₹90 off, not
    // ₹89): at most 99 paise per order, and a promo that rounds against the
    // person redeeming it is a bad look for the sake of a rupee.
    const raw = (base * c.value) / 100;
    discount = Math.ceil(raw / 100) * 100;
    if (c.max_discount_paise !== null && discount > c.max_discount_paise) {
      discount = c.max_discount_paise;
    }
  } else if (c.kind === "fixed") {
    discount = c.value;
  } else if (c.kind === "shipping") {
    // Free shipping is NOT a subtotal discount. Subtracting it here would take
    // the money off the items as well as waiving the shipping line.
    freeShipping = true;
  } else {
    // Unreachable via the admin UI, which validates kind on write. If a row is
    // ever malformed, refuse rather than silently charging full price for a code
    // the customer was shown as valid.
    console.error("coupon has an unknown kind", c.code, c.kind);
    return { error: "That promo code isn't valid." };
  }

  // Clamp. A ₹500-off code on a ₹299 cart gives ₹299 off, never a negative
  // total — Razorpay rejects those, and the customer would see a broken
  // checkout rather than a discount.
  // For a scoped code the clamp is the ELIGIBLE subtotal: a ₹300-off code on one
  // ₹250 product in a ₹1,000 cart gives ₹250 off, never ₹300 off the rest.
  if (discount > base) discount = base;
  if (discount < 0) discount = 0;

  return { coupon: c, discount_paise: discount, free_shipping: freeShipping, applies_to: appliesTo };
}

// Called from the order.paid webhook branch, never from order creation.
//
// The UNIQUE index on coupon_redemptions(order_id) is what makes this safe under
// webhook redelivery: the second INSERT violates the constraint and the counter
// is not touched. INSERT OR IGNORE turns that into a silent no-op, and `changes`
// tells us whether this delivery was the one that counted.
export async function recordRedemption(env, { couponCode, orderId, email, userId }) {
  if (!couponCode) return;
  const code = normaliseCode(couponCode);

  const c = await env.DB.prepare(`SELECT id FROM coupons WHERE code = ?`).bind(code).first();
  if (!c) {
    // The coupon was deleted between the order being placed and paid. The order
    // keeps its snapshot columns, so the customer's receipt is unaffected.
    console.warn("redemption for a coupon that no longer exists", code);
    return;
  }

  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO coupon_redemptions (id, coupon_id, order_id, email, user_id, created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(uid(), c.id, orderId, clip(email, 160), userId || null, now()).run();

  if (ins.meta?.changes === 0) return; // already recorded — a redelivery

  await env.DB.prepare(`UPDATE coupons SET uses = uses + 1, updated_at = ? WHERE id = ?`)
    .bind(now(), c.id).run();
}

// ── admin CRUD ────────────────────────────────────────────────────
// Owner-only. Like every handler in admin.js these assume the positional gate in
// index.js has already authenticated the caller — they never check auth
// themselves, so the gate must stay above them.

function validateCouponBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  const has = (k) => k in (body || {});

  if (!partial || has("code")) {
    const code = normaliseCode(body?.code);
    if (code.length < 3) errors.push("Code must be at least 3 characters.");
    else if (!/^[A-Z0-9_-]+$/.test(code)) {
      errors.push("Code can only contain letters, numbers, dashes and underscores.");
    }
    out.code = code;
  }

  if (!partial || has("kind")) {
    const kind = clip(body?.kind, 20);
    if (!KINDS.includes(kind)) errors.push(`Kind must be one of: ${KINDS.join(", ")}.`);
    out.kind = kind;
  }

  if (!partial || has("value")) {
    const value = parseInt0(body?.value);
    if (value === null) errors.push("Value must be a whole number.");
    out.value = value ?? 0;
  }

  // Cross-field: a percentage over 100 would produce a negative price, and 0%
  // is a coupon that does nothing — both are almost certainly a typo for the
  // other kind.
  const kind = out.kind ?? null;
  if (kind === "percent" && out.value !== undefined) {
    if (out.value < 1 || out.value > 100) errors.push("A percentage must be between 1 and 100.");
  }
  if (kind === "fixed" && out.value !== undefined && out.value < 1) {
    errors.push("A fixed discount must be at least 1 paise.");
  }
  if (kind === "shipping") out.value = 0;

  if (has("min_order_paise")) {
    const v = parseInt0(body.min_order_paise);
    if (v === null) errors.push("Minimum order must be a whole number of paise.");
    out.min_order_paise = v ?? 0;
  }

  if (has("max_discount_paise")) {
    const raw = body.max_discount_paise;
    if (raw === null || raw === "") out.max_discount_paise = null;
    else {
      const v = parseInt0(raw);
      if (v === null) errors.push("Maximum discount must be a whole number of paise.");
      out.max_discount_paise = v;
    }
  }

  if (has("expires_at")) {
    const raw = body.expires_at;
    if (raw === null || raw === "") out.expires_at = null;
    else {
      // Accept either epoch ms or a yyyy-mm-dd from a date input. A bare date is
      // read as END of that day so a coupon "valid until the 15th" works ON the
      // 15th — the intuitive reading, and the one a customer will assume.
      //
      // Parsed as UTC, which in IST (+5:30) means the code actually stops at
      // 05:29 the NEXT morning. Checked deliberately: erring long is the right
      // direction here. Someone reading "valid until the 15th" who redeems at
      // 11pm on the 15th succeeds, where a UTC-midnight cutoff would have
      // rejected them five and a half hours early with no explanation.
      let ms = null;
      if (typeof raw === "number") ms = raw;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim())) {
        ms = Date.parse(String(raw).trim() + "T23:59:59.999Z");
      } else if (/^\d+$/.test(String(raw).trim())) {
        ms = Number(String(raw).trim());
      }
      if (!Number.isFinite(ms)) errors.push("Expiry must be a date (yyyy-mm-dd).");
      out.expires_at = Number.isFinite(ms) ? ms : null;
    }
  }

  if (has("max_uses")) {
    const raw = body.max_uses;
    if (raw === null || raw === "") out.max_uses = null;
    else {
      const v = parseInt0(raw);
      if (v === null || v < 1) errors.push("Total uses must be a positive whole number.");
      out.max_uses = v;
    }
  }

  if (has("once_per_customer")) out.once_per_customer = body.once_per_customer ? 1 : 0;
  if (has("active")) out.active = body.active ? 1 : 0;

  // Optional. Absent = leave the scope alone (update) or none (create). An empty
  // list or null CLEARS it — back to the whole cart — and must be settable.
  if (has("product_ids")) {
    const raw = body.product_ids;
    if (raw === null || raw === "") out.product_ids = [];
    else if (!Array.isArray(raw)) errors.push("product_ids must be a list of product ids.");
    else {
      const ids = [...new Set(raw.map((v) => clip(v, 64)).filter(Boolean))];
      if (ids.length > 50) errors.push("A code can be limited to at most 50 products.");
      out.product_ids = ids;
    }
  }

  return { fields: out, errors };
}

// Every id must be a real product, or the code would silently apply to nothing.
// Returns the error message, or null.
async function checkProductIds(env, ids) {
  if (!ids.length) return null;
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM products WHERE id IN (${ph})`).bind(...ids).all();
  const known = new Set((results || []).map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  return missing.length ? `Unknown product id: ${missing[0]}` : null;
}

// Replace a code's scope wholesale, in one batch. Deleting first makes the
// write idempotent and makes "clear it" the same operation as "set it".
async function writeScope(env, couponId, ids) {
  const stmts = [env.DB.prepare(`DELETE FROM coupon_products WHERE coupon_id = ?`).bind(couponId)];
  for (const pid of ids) {
    stmts.push(env.DB.prepare(
      `INSERT INTO coupon_products (coupon_id, product_id) VALUES (?, ?)`).bind(couponId, pid));
  }
  await env.DB.batch(stmts);
}

// One coupon as the dashboard wants it: the row plus its products by name.
async function readCoupon(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, once_per_customer, active, created_at, updated_at
       FROM coupons WHERE id = ?`
  ).bind(id).first();
  if (!row) return null;
  const scope = await couponScope(env, id);
  return { ...row, products: scope.map((s) => ({ id: s.product_id, name: s.name })) };
}

export async function listCoupons(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, once_per_customer, active, created_at, updated_at
       FROM coupons ORDER BY active DESC, created_at DESC`
  ).all();

  // What each code has actually COST, joined from the orders it was used on.
  // `uses` alone says a code was redeemed 37 times; it does not say that those
  // 37 orders gave away ₹4,200 and brought in ₹31,000 — which is the number that
  // decides whether a promo was worth running.
  //
  // Counted from PAID orders only (paid or shipped): a pending order is money
  // that has not arrived, and including it would overstate both figures.
  const { results: totals } = await env.DB.prepare(
    `SELECT coupon_code,
            COUNT(*) AS orders,
            COALESCE(SUM(discount_paise), 0) AS discount_paise,
            COALESCE(SUM(total_paise), 0) AS revenue_paise,
            MAX(created_at) AS last_used
       FROM orders
      WHERE coupon_code IS NOT NULL AND status IN ('paid','shipped')
      GROUP BY coupon_code`
  ).all();

  const byCode = new Map((totals || []).map((t) => [String(t.coupon_code).toUpperCase(), t]));

  // Which products each code is limited to. One query for the whole list, then
  // grouped here; a code with no rows shows an empty list, meaning "everything".
  const { results: scoped } = await env.DB.prepare(
    `SELECT cp.coupon_id, cp.product_id, p.name
       FROM coupon_products cp
       JOIN products p ON p.id = cp.product_id
      ORDER BY p.name`
  ).all();
  const productsOf = new Map();
  for (const r of scoped || []) {
    if (!productsOf.has(r.coupon_id)) productsOf.set(r.coupon_id, []);
    productsOf.get(r.coupon_id).push({ id: r.product_id, name: r.name });
  }

  const coupons = (results || []).map((c) => {
    const t = byCode.get(String(c.code).toUpperCase());
    return {
      ...c,
      products: productsOf.get(c.id) || [],
      paid_orders: t?.orders || 0,
      given_away_paise: t?.discount_paise || 0,
      revenue_paise: t?.revenue_paise || 0,
      last_used_at: t?.last_used || null,
    };
  });

  return json({ coupons });
}

// GET /api/admin/coupons/:id/redemptions
//
// Who used a code and when. Separate from the list because it is per-coupon
// detail rather than something to load for every row, and because it returns
// customer emails — worth keeping to an explicit request.
export async function couponRedemptions(env, id) {
  const c = await env.DB.prepare(`SELECT id, code FROM coupons WHERE id = ?`).bind(id).first();
  if (!c) return bad("Coupon not found.", 404);

  const { results } = await env.DB.prepare(
    `SELECT r.email, r.created_at, o.receipt, o.status,
            o.discount_paise, o.total_paise
       FROM coupon_redemptions r
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.coupon_id = ?
      ORDER BY r.created_at DESC
      LIMIT 200`
  ).bind(id).all();

  return json({ code: c.code, redemptions: results || [] });
}

export async function createCoupon(env, body) {
  const { fields, errors } = validateCouponBody(body);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  const dup = await env.DB.prepare(`SELECT id FROM coupons WHERE code = ?`).bind(fields.code).first();
  if (dup) return bad("A coupon with that code already exists.", 409);

  // Checked BEFORE the insert, so a typo in a product id leaves no half-made code.
  const scopeIds = fields.product_ids || [];
  const badId = await checkProductIds(env, scopeIds);
  if (badId) return bad(badId);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO coupons (id, code, kind, value, min_order_paise, max_discount_paise,
       expires_at, max_uses, uses, once_per_customer, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`
  ).bind(
    id, fields.code, fields.kind, fields.value,
    fields.min_order_paise ?? 0, fields.max_discount_paise ?? null,
    fields.expires_at ?? null, fields.max_uses ?? null,
    fields.once_per_customer ?? 0, fields.active ?? 1, ts, ts,
  ).run();
  if (scopeIds.length) await writeScope(env, id, scopeIds);

  return json({ ok: true, coupon: await readCoupon(env, id) }, 201);
}

// PATCH semantics, same as updateProduct: only the fields present in the body
// are touched.
export async function updateCoupon(env, id, body) {
  // The WHOLE row, not (id, kind, value).
  //
  // The merge below is validated in FULL mode, which requires a code — and the
  // narrower SELECT meant `code` was never in the merged object, so every patch
  // that did not resend it was rejected with "Code must be at least 3 characters."
  // The dashboard deliberately never sends it (renaming a coupon invalidates every
  // copy a customer already holds), so in practice EVERY edit failed, including the
  // one-field Pause button. Aswin hit it capping WELCOME10 at ₹100.
  //
  // Selecting * also means a field added to the validator later is covered without
  // anyone remembering to widen this query — the same reason the API cache is an
  // allowlist rather than a list of exceptions.
  const existing = await env.DB.prepare(
    `SELECT * FROM coupons WHERE id = ?`
  ).bind(id).first();
  if (!existing) return bad("Coupon not found.", 404);

  // Validate against the MERGED row, not the patch alone: sending {value: 150}
  // on an existing percent coupon has to be rejected, and the patch by itself
  // carries no kind to check it against.
  const merged = { ...existing, ...(body || {}) };
  const { errors } = validateCouponBody(merged);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  const { fields } = validateCouponBody(body, { partial: true });

  const sets = [];
  const args = [];
  const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };

  for (const col of ["code", "kind", "value", "min_order_paise", "max_discount_paise",
                     "expires_at", "max_uses", "once_per_customer", "active"]) {
    if (col in fields) put(col, fields[col]);
  }

  // A patch that only changes the products is a real edit, not "nothing".
  const scopeChange = "product_ids" in fields;
  if (!sets.length && !scopeChange) return bad("Nothing to update.");

  if (scopeChange) {
    const badId = await checkProductIds(env, fields.product_ids);
    if (badId) return bad(badId);
  }

  if ("code" in fields) {
    const dup = await env.DB.prepare(
      `SELECT id FROM coupons WHERE code = ? AND id != ?`
    ).bind(fields.code, id).first();
    if (dup) return bad("Another coupon already uses that code.", 409);
  }

  put("updated_at", now());
  args.push(id);
  await env.DB.prepare(`UPDATE coupons SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  if (scopeChange) await writeScope(env, id, fields.product_ids);

  return json({ ok: true, coupon: await readCoupon(env, id) });
}

// Mirrors deleteProduct: a coupon that has been redeemed is DEACTIVATED rather
// than deleted, so the redemption history and the once-per-customer check
// survive. Deleting would cascade the redemptions away and silently re-entitle
// everyone who had already used it.
export async function deleteCoupon(env, id) {
  const row = await env.DB.prepare(`SELECT id, code FROM coupons WHERE id = ?`).bind(id).first();
  if (!row) return bad("Coupon not found.", 404);

  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?`
  ).bind(id).first();

  if ((used?.n || 0) > 0) {
    await env.DB.prepare(`UPDATE coupons SET active = 0, updated_at = ? WHERE id = ?`)
      .bind(now(), id).run();
    return json({
      ok: true, deactivated: true, redemptions: used.n,
      message: `"${row.code}" has been used ${used.n} time(s), so it was deactivated rather than deleted. It will no longer be accepted.`,
    });
  }

  await env.DB.prepare(`DELETE FROM coupons WHERE id = ?`).bind(id).run();
  return json({ ok: true, deleted: true });
}
