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
export async function applyCoupon(env, rawCode, subtotalPaise, email) {
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
    const raw = (subtotalPaise * c.value) / 100;
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
  if (discount > subtotalPaise) discount = subtotalPaise;
  if (discount < 0) discount = 0;

  return { coupon: c, discount_paise: discount, free_shipping: freeShipping };
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

  return { fields: out, errors };
}

export async function listCoupons(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, once_per_customer, active, created_at, updated_at
       FROM coupons ORDER BY active DESC, created_at DESC`
  ).all();
  return json({ coupons: results || [] });
}

export async function createCoupon(env, body) {
  const { fields, errors } = validateCouponBody(body);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  const dup = await env.DB.prepare(`SELECT id FROM coupons WHERE code = ?`).bind(fields.code).first();
  if (dup) return bad("A coupon with that code already exists.", 409);

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

  const row = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, once_per_customer, active, created_at, updated_at
       FROM coupons WHERE id = ?`
  ).bind(id).first();
  return json({ ok: true, coupon: row }, 201);
}

// PATCH semantics, same as updateProduct: only the fields present in the body
// are touched.
export async function updateCoupon(env, id, body) {
  const existing = await env.DB.prepare(
    `SELECT id, kind, value FROM coupons WHERE id = ?`
  ).bind(id).first();
  if (!existing) return bad("Coupon not found.", 404);

  // Validate against the MERGED row, not the patch alone: sending {value: 150}
  // on an existing percent coupon has to be rejected, and the patch by itself
  // carries no kind to check it against.
  const merged = { kind: existing.kind, value: existing.value, ...(body || {}) };
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

  if (!sets.length) return bad("Nothing to update.");

  if ("code" in fields) {
    const dup = await env.DB.prepare(
      `SELECT id FROM coupons WHERE code = ? AND id != ?`
    ).bind(fields.code, id).first();
    if (dup) return bad("Another coupon already uses that code.", 409);
  }

  put("updated_at", now());
  args.push(id);
  await env.DB.prepare(`UPDATE coupons SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();

  const row = await env.DB.prepare(
    `SELECT id, code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, once_per_customer, active, created_at, updated_at
       FROM coupons WHERE id = ?`
  ).bind(id).first();
  return json({ ok: true, coupon: row });
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
