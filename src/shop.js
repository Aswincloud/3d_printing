// Catalogue reads and the money maths.
//
// The amount functions live here rather than in the order handler because
// they're the part that must be unit-testable in isolation: they are the only
// thing standing between a tampered cart and a wrong charge.

import { json } from "./lib.js";

// ── products ──────────────────────────────────────────────────────
// Public listing. Only visible rows, and deliberately no internal columns.
export async function listProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, name, description, price_paise, image, images, category, sort
       FROM products WHERE visible = 1 ORDER BY sort ASC, name ASC`
  ).all();

  return json({
    products: (results || []).map(shape),
    shipping: shippingConfig(env),
  });
}

// `images` is stored comma-separated; the API hands back an array so the
// frontend never has to know that.
function shape(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description || "",
    price_paise: r.price_paise,
    image: r.image,
    images: r.images ? r.images.split(",").filter(Boolean) : [],
    category: r.category || "",
  };
}

// ── shipping ──────────────────────────────────────────────────────
// Both amounts are wrangler.toml vars, so they're editable without a code
// change. They arrive as strings; coerce once, here.
export function shippingConfig(env) {
  return {
    flat_paise: intVar(env.FLAT_SHIP_PAISE, 9900),
    free_threshold_paise: intVar(env.FREE_SHIP_THRESHOLD_PAISE, 150000),
  };
}

function intVar(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Free over the threshold, flat rate otherwise.
// `>=` is intentional: an order exactly at the threshold ships free.
//
// The `delivery` parameter is kept in the signature but no longer branches on:
// pickup was withdrawn (everything ships now), and the old `if (delivery ===
// "pickup") return 0` was a free-shipping path reachable by anyone who could set
// that field. createOrderHandler now hardcodes "ship", so this is belt-and-braces
// — a second place the value would have to be honoured for the bug to return.
export function shippingFor(subtotalPaise, delivery, env) {
  const { flat_paise, free_threshold_paise } = shippingConfig(env);
  return subtotalPaise >= free_threshold_paise ? 0 : flat_paise;
}

// ── cart pricing ──────────────────────────────────────────────────
// THE security-critical function. Takes only {product_id, qty} pairs and
// returns amounts derived entirely from D1. Any `price` field on the input is
// ignored — it is never read, so a tampered cart cannot change the charge.
//
// Returns { items, subtotal_paise, shipping_paise, total_paise } or
// { error }.
export const MAX_QTY = 100;

export async function priceCart(env, rawItems, delivery) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "Your cart is empty." };
  }
  if (rawItems.length > 50) {
    return { error: "Too many different items in one order." };
  }

  // Collapse duplicate product_ids so the same item twice can't bypass the
  // per-line qty cap.
  const wanted = new Map();
  for (const it of rawItems) {
    const id = String(it?.product_id ?? "").trim();
    const qty = parseInt(it?.qty, 10);
    if (!id) return { error: "Invalid item in cart." };
    if (!Number.isFinite(qty) || qty < 1) return { error: "Invalid quantity." };
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }

  for (const qty of wanted.values()) {
    if (qty > MAX_QTY) return { error: `Maximum ${MAX_QTY} of any one item per order.` };
  }

  const ids = [...wanted.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, name, price_paise FROM products
      WHERE visible = 1 AND id IN (${placeholders})`
  ).bind(...ids).all();

  const found = new Map((results || []).map((r) => [r.id, r]));

  // A missing id means either a bogus product or one that's been hidden since
  // the cart was filled. Either way, refuse rather than silently dropping it —
  // a customer must never be charged for a different basket than they saw.
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    return { error: "An item in your cart is no longer available. Please refresh and try again." };
  }

  // Preserve the order the client sent, for display.
  const items = [];
  let subtotal = 0;
  let pos = 0;
  for (const id of ids) {
    const row = found.get(id);
    const qty = wanted.get(id);
    subtotal += row.price_paise * qty;
    items.push({
      product_id: row.id,
      name: row.name,          // snapshot
      price_paise: row.price_paise, // snapshot
      qty,
      pos: pos++,
    });
  }

  const shipping = shippingFor(subtotal, delivery, env);
  return {
    items,
    subtotal_paise: subtotal,
    shipping_paise: shipping,
    total_paise: subtotal + shipping,
  };
}
