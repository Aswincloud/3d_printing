// Shopper activity (2026-10-22): a dashboard view of what visitors are doing on
// the way to buying, including guests whose carts live only in their browser.
//
// POST /api/activity — public, unauthenticated, and built so that is harmless:
//   - it can only INSERT one row from a fixed set of kinds; it sends nothing,
//     prices nothing, and reveals nothing (the reply is always {ok:true});
//   - the product id must be a real visible product, the quantity is clamped,
//     and the receipt is only kept if it is a real order created in the last
//     few minutes — so a forged event cannot attach itself to old orders;
//   - the visitor id is random and per-browser; no IP, name, email or phone is
//     stored. The account id comes from the session cookie, never the body;
//   - rate-limited per IP (RL_ACTIVITY), and rows older than 30 days are pruned.
//
// GET /api/admin/activity — owner only, behind the admin gate in index.js.
import { json, now } from "./lib.js";

export const KINDS = new Set(["view", "cart_add", "cart_remove", "checkout_open", "pay_click"]);
const SID_RE = /^[0-9a-f]{16}$/;
const RECEIPT_RE = /^AP-[0-9a-f]{8}$/;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_WINDOW_MS = 10 * 60 * 1000;

export async function recordActivity(env, body, userId = null) {
  const ok = json({ ok: true });
  const kind = String(body?.kind || "");
  const sid = String(body?.sid || "");
  if (!KINDS.has(kind) || !SID_RE.test(sid)) return ok;

  let productId = null;
  if (body?.product_id != null) {
    const p = await env.DB.prepare(`SELECT id FROM products WHERE id = ? AND visible = 1`)
      .bind(String(body.product_id).slice(0, 64)).first();
    if (!p) return ok;                    // an unknown product is dropped, not stored
    productId = p.id;
  }
  const qty = Number.isInteger(body?.qty) ? Math.max(1, Math.min(100, body.qty)) : null;

  let receipt = null;
  if (kind === "pay_click" && RECEIPT_RE.test(String(body?.receipt || ""))) {
    const o = await env.DB.prepare(`SELECT receipt FROM orders WHERE receipt = ? AND created_at > ?`)
      .bind(body.receipt, now() - RECEIPT_WINDOW_MS).first();
    receipt = o?.receipt || null;
  }

  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO shopper_events (sid, kind, product_id, qty, user_id, receipt, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(sid, kind, productId, qty, userId, receipt, t),
    env.DB.prepare(`DELETE FROM shopper_events WHERE created_at < ?`).bind(t - KEEP_MS),
  ]);
  return ok;
}

// One row per visitor session, newest first, for the last `hours` (default 24).
// "Live" = any event in the last 15 minutes. The furthest step reached decides
// the label, so a visitor who opened checkout and went back to browsing still
// reads as "reached checkout".
const STEP = { view: 1, cart_add: 2, cart_remove: 2, checkout_open: 3, pay_click: 4 };
// Money received. A cancelled, failed or refunded order is shown by its own
// status, never as "paid".
const PAID = new Set(["paid", "in_production", "ready", "shipped", "delivered"]);
const LIVE_MS = 15 * 60 * 1000;

export async function adminActivity(env, url) {
  const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours")) || 24));
  const since = now() - hours * 60 * 60 * 1000;
  // The NEWEST 5000 (DESC + LIMIT), then folded oldest-first. Ascending with the
  // limit would keep the oldest events and drop the live ones on a busy range.
  const { results } = await env.DB.prepare(
    `SELECT e.sid, e.kind, e.product_id, e.qty, e.user_id, e.receipt, e.created_at,
            p.name AS product_name, u.name AS user_name, u.email AS user_email,
            o.status AS order_status
       FROM shopper_events e
       LEFT JOIN products p ON p.id = e.product_id
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN orders o ON o.receipt = e.receipt
      WHERE e.created_at >= ?
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 5000`).bind(since).all();
  const events = (results || []).reverse();

  const bySid = new Map();
  for (const r of events) {
    let s = bySid.get(r.sid);
    if (!s) {
      s = { sid: r.sid, first_at: r.created_at, last_at: r.created_at, step: 0, viewed: [], cart: new Map(),
            user: null, receipt: null, order_status: null, events: 0 };
      bySid.set(r.sid, s);
    }
    s.last_at = r.created_at;
    s.events++;
    s.step = Math.max(s.step, STEP[r.kind] || 0);
    if (r.user_id) s.user = { name: r.user_name || "", email: r.user_email || "" };
    if (r.receipt) { s.receipt = r.receipt; s.order_status = r.order_status || null; }
    if (r.kind === "view" && r.product_name && !s.viewed.includes(r.product_name)) s.viewed.push(r.product_name);
    // The cart as last reported: cart_add carries the new quantity of that line.
    if (r.kind === "cart_add" && r.product_name) s.cart.set(r.product_name, r.qty || 1);
    if (r.kind === "cart_remove" && r.product_name) s.cart.delete(r.product_name);
  }

  const t = now();
  const label = (s) => PAID.has(s.order_status) ? "paid"
    : s.order_status && s.order_status !== "pending" ? s.order_status        // cancelled, refunded, failed
    : ["browsing", "browsing", "cart", "checkout", "pressed pay"][s.step] || "browsing";
  const sessions = [...bySid.values()]
    .map((s) => ({
      sid: s.sid, stage: label(s), live: t - s.last_at < LIVE_MS,
      first_at: s.first_at, last_at: s.last_at, events: s.events,
      viewed: s.viewed.slice(-6), cart: [...s.cart].map(([name, qty]) => ({ name, qty })),
      user: s.user, receipt: s.receipt, order_status: s.order_status,
    }))
    .sort((a, b) => b.last_at - a.last_at);

  return json({
    hours, sessions,
    summary: {
      visitors: sessions.length,
      live: sessions.filter((s) => s.live).length,
      carts: sessions.filter((s) => ["cart", "checkout", "pressed pay", "paid"].includes(s.stage)).length,
      checkouts: sessions.filter((s) => ["checkout", "pressed pay", "paid"].includes(s.stage)).length,
      paid: sessions.filter((s) => s.stage === "paid").length,
    },
  });
}
