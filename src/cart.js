// Server-side cart for signed-in customers, so it follows them between devices.
//
// INVARIANT 9: rows hold only (user_id, product_id, qty). No price, no name —
// exactly the same discipline as the localStorage cart this supplements. Amounts
// come from priceCart() in shop.js reading the products table, and nothing here
// changes that. A customer who edits their own cart rows via any means can
// change what they SEE; the charge is computed server-side at checkout.
//
// Guests keep using localStorage. On sign-in the browser POSTs its guest cart to
// /api/me/cart/merge and then clears localStorage, so afterwards there is one
// source of truth rather than two that can drift.

import { json, bad, now } from "./lib.js";
import { MAX_QTY } from "./shop.js";

const MAX_LINES = 50;      // matches priceCart's cap on distinct items

// Normalise an inbound [{product_id, qty}] list: drop anything malformed, sum
// duplicates, clamp to MAX_QTY. Deliberately tolerant — a stale browser cart
// referencing a since-deleted product shouldn't 400 the whole request, it should
// just lose that line.
function normalise(items) {
  if (!Array.isArray(items)) return null;
  const map = new Map();
  for (const it of items.slice(0, MAX_LINES * 2)) {
    const id = String(it?.product_id ?? it?.id ?? "").trim();
    const qty = parseInt(it?.qty, 10);
    if (!id || !Number.isFinite(qty) || qty < 1) continue;
    map.set(id, Math.min(MAX_QTY, (map.get(id) || 0) + qty));
  }
  return map;
}

// Keep only ids that are real and currently on sale. A hidden or deleted product
// must not sit in a cart implying it can be bought.
async function visibleIds(env, ids) {
  if (!ids.length) return new Set();
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM products WHERE visible = 1 AND id IN (${ph})`
  ).bind(...ids).all();
  return new Set((results || []).map((r) => r.id));
}

async function readCart(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT c.product_id, c.qty FROM cart_items c
       JOIN products p ON p.id = c.product_id
      WHERE c.user_id = ? AND p.visible = 1
      ORDER BY c.updated_at`
  ).bind(userId).all();
  return (results || []).map((r) => ({ product_id: r.product_id, qty: r.qty }));
}

async function writeCart(env, userId, map) {
  const stmts = [
    env.DB.prepare(`DELETE FROM cart_items WHERE user_id = ?`).bind(userId),
  ];
  const t = now();
  for (const [productId, qty] of map) {
    stmts.push(env.DB.prepare(
      `INSERT INTO cart_items (user_id, product_id, qty, updated_at) VALUES (?,?,?,?)`
    ).bind(userId, productId, qty, t));
  }
  await env.DB.batch(stmts);
}

// ── GET /api/me/cart ──────────────────────────────────────────────
export async function getCart(env, user) {
  return json({ items: await readCart(env, user.id) });
}

// ── PUT /api/me/cart ──────────────────────────────────────────────
// Replaces the cart wholesale. Simpler than per-line PATCH semantics, and the
// browser already holds the complete intended state.
export async function putCart(env, user, body) {
  const map = normalise(body?.items);
  if (map === null) return bad("Expected an items array.");
  if (map.size > MAX_LINES) return bad(`No more than ${MAX_LINES} different items.`);

  const allowed = await visibleIds(env, [...map.keys()]);
  for (const id of [...map.keys()]) if (!allowed.has(id)) map.delete(id);

  await writeCart(env, user.id, map);
  return json({ items: await readCart(env, user.id) });
}

// ── POST /api/me/cart/merge ───────────────────────────────────────
// Called once, right after sign-in, with whatever the guest had in localStorage.
// Quantities SUM with anything already on the account — someone who added two of
// a thing on their phone and one on a laptop should end up with three, not have
// one silently overwrite the other. MAX_QTY still caps the result.
export async function mergeCart(env, user, body) {
  const incoming = normalise(body?.items);
  if (incoming === null) return bad("Expected an items array.");

  const existing = await readCart(env, user.id);
  const map = new Map(existing.map((r) => [r.product_id, r.qty]));
  for (const [id, qty] of incoming) {
    map.set(id, Math.min(MAX_QTY, (map.get(id) || 0) + qty));
  }

  if (map.size > MAX_LINES) {
    // Keep the earliest lines rather than failing the sign-in outright.
    const trimmed = new Map([...map].slice(0, MAX_LINES));
    map.clear();
    for (const [k, v] of trimmed) map.set(k, v);
  }

  const allowed = await visibleIds(env, [...map.keys()]);
  for (const id of [...map.keys()]) if (!allowed.has(id)) map.delete(id);

  await writeCart(env, user.id, map);
  return json({ items: await readCart(env, user.id), merged: incoming.size });
}
