// Product reviews (2026-10-19).
//
// Public:   POST /api/reviews {slug, rating, name, body}   — anyone may post
// Owner:    GET /api/admin/reviews, DELETE /api/admin/reviews/:id,
//           POST /api/admin/reviews  (a real review received elsewhere)
// Rendered: on the product page, server-side, from listForProduct().
//
// Three rules carry the weight here:
//
//  1. VERIFIED IS DECIDED BY THE SERVER, from the reviewer's own session: a paid
//     (or later) order on their account containing this product. Nothing in the
//     request can set it. A badge a form field could switch on would be worse
//     than no badge.
//
//  2. THE SHOP DOES NOT WRITE ITS OWN REVIEWS. The owner can record a review a
//     real customer sent on WhatsApp or Instagram, and it is published labelled
//     with where it came from ("via WhatsApp"), never as an anonymous site
//     review and never as verified. Seller-written reviews shown as customers'
//     are fake reviews, misleading to buyers and an unfair trade practice.
//
//  3. A PUBLIC FORM IS A SPAM TARGET. Length limits, no links, a honeypot field,
//     and a per-IP limit (5 an hour, keyed on a salted hash — the address itself
//     is never stored). Every post emails the owner, who can delete any review.
//     Reviews go live immediately, as asked; deletion is the moderation.
import { json, bad, uid, now, esc, sendEmail, trimSlashes } from "./lib.js";
import { currentCustomer } from "./customers.js";

export const REVIEW_LIMITS = { name: 60, body: 1000, minBody: 10, perIpPerHour: 5, ownerNote: 40 };
const PAID_STATUSES = ["paid", "in_production", "ready", "shipped", "delivered"];

// "vr0820588@gmail.com" -> "vr*****8@gmail.com": the first two and last
// character of the name part, the domain kept. Short names keep one character.
// "" for anything that is not an email.
export function maskEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return "";
  const local = e.slice(0, at), domain = e.slice(at + 1);
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  const stars = "*".repeat(Math.min(Math.max(local.length - 3, 1), 5));
  return `${local.slice(0, 2)}${stars}${local.slice(-1)}@${domain}`;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Validate and clean one review. Returns { error } or { rating, name, body }.
export function cleanReview(b) {
  const rating = Number(b?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: "Choose a rating from 1 to 5 stars." };
  const name = String(b?.name ?? "").replace(/\s+/g, " ").trim().slice(0, REVIEW_LIMITS.name);
  if (name.length < 2) return { error: "Please add your name." };
  const body = String(b?.body ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length < REVIEW_LIMITS.minBody) return { error: `Please write at least ${REVIEW_LIMITS.minBody} characters.` };
  if (body.length > REVIEW_LIMITS.body) return { error: `Please keep it under ${REVIEW_LIMITS.body} characters.` };
  // Links are the signature of review spam, and a product review never needs one.
  if (/https?:\/\/|www\.|\.(com|in|net|org|xyz|top|ru)\b/i.test(name + " " + body)) {
    return { error: "Links aren't allowed in reviews." };
  }
  return { rating, name, body };
}

// The reviews shown on a product page, newest first, plus the summary.
export async function listForProduct(env, productId) {
  const { results } = await env.DB.prepare(
    `SELECT id, rating, name, body, verified, source, source_note, email_masked, created_at
       FROM reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(productId).all();
  const reviews = results || [];
  const count = reviews.length;
  const avg = count ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { reviews, count, avg: Math.round(avg * 10) / 10 };
}

// POST /api/reviews
export async function submitReview(request, env, body, ctx) {
  // Honeypot: a field real visitors never see. A bot that fills it is told
  // "thanks" and nothing is stored, so it has no signal to adapt to.
  if (String(body?.website ?? "").trim()) return json({ ok: true });

  const slug = String(body?.slug ?? "").trim().slice(0, 80);
  const product = slug ? await env.DB.prepare(
    `SELECT id, slug, name FROM products WHERE slug = ? AND visible = 1`).bind(slug).first() : null;
  if (!product) return bad("That product isn't available.", 404);

  const c = cleanReview(body);
  if (c.error) return bad(c.error);

  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha256Hex(`${env.SESSION_SECRET || "reviews"}|${ip}`)).slice(0, 32) : "";
  if (ipHash) {
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reviews WHERE ip_hash = ? AND created_at > ?`
    ).bind(ipHash, now() - 60 * 60 * 1000).first();
    if ((recent?.n || 0) >= REVIEW_LIMITS.perIpPerHour) {
      return bad("Too many reviews from this connection — please try again later.", 429);
    }
  }

  // Verified: the reviewer's own account has a paid order containing it.
  const user = await currentCustomer(request, env).catch(() => null);
  let orderId = null;
  if (user) {
    const ph = PAID_STATUSES.map(() => "?").join(",");
    const hit = await env.DB.prepare(
      `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND oi.product_id = ? AND o.status IN (${ph})
        ORDER BY o.created_at DESC LIMIT 1`
    ).bind(user.id, product.id, ...PAID_STATUSES).first();
    orderId = hit?.id || null;
  }

  const id = uid();
  const t = now();
  // From the session only, and only ever stored masked.
  const emailMasked = user ? maskEmail(user.email) : "";
  await env.DB.prepare(
    `INSERT INTO reviews (id, product_id, rating, name, body, verified, user_id, order_id, source, source_note, ip_hash, email_masked, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'site', '', ?, ?, ?)`
  ).bind(id, product.id, c.rating, c.name, c.body, orderId ? 1 : 0, user?.id || null, orderId, ipHash, emailMasked, t).run();

  const mail = notifyOwner(env, { product, review: { ...c, verified: Boolean(orderId) } });
  if (ctx?.waitUntil) ctx.waitUntil(mail); else await mail;

  return json({ ok: true, review: { id, rating: c.rating, name: c.name, body: c.body, verified: Boolean(orderId), email_masked: emailMasked, created_at: t } }, 201);
}

async function notifyOwner(env, { product, review }) {
  const to = String(env.OWNER_EMAIL || "").split(",")[0].trim();
  if (!to || !env.RESEND_API_KEY) return;
  const site = trimSlashes(env.APP_BASE_URL || "https://3d-prints.aswincloud.com");
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  const r = await sendEmail(env, {
    to,
    subject: `New ${review.rating}★ review on ${product.name}${review.verified ? " (verified buyer)" : ""}`,
    text: `${stars}  ${review.name}${review.verified ? " — verified buyer" : ""}\n\n${review.body}\n\n` +
          `Product: ${site}/p/${product.slug}\nDelete it from the dashboard: ${site}/shop.html#reviews\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;padding:20px">
      <p style="font-size:18px;color:#b45309;margin:0">${stars}</p>
      <p><b>${esc(review.name)}</b>${review.verified ? ' <span style="color:#166534">· verified buyer</span>' : ""}</p>
      <p style="white-space:pre-wrap">${esc(review.body)}</p>
      <p><a href="${site}/p/${esc(product.slug)}">${esc(product.name)}</a> · <a href="${site}/shop.html#reviews">Manage reviews</a></p></div>`,
  }).catch((e) => ({ ok: false, error: e?.message }));
  if (r && r.ok === false) console.error("review notification failed", product.slug, r.error);
}

// ── owner ─────────────────────────────────────────────────────────
// Every handler below assumes the positional admin gate in index.js already ran.

export async function adminListReviews(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.rating, r.name, r.body, r.verified, r.source, r.source_note, r.email_masked, r.created_at,
            p.name AS product_name, p.slug AS product_slug
       FROM reviews r JOIN products p ON p.id = r.product_id
      ORDER BY r.created_at DESC LIMIT 500`
  ).all();
  return json({ reviews: results || [] });
}

export async function adminDeleteReview(env, id) {
  const res = await env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(id).run();
  if (!res.meta?.changes) return bad("Review not found.", 404);
  return json({ ok: true });
}

// A review a real customer sent outside the site. `source_note` is required and
// is shown publicly ("via WhatsApp"), so it can never pass as a site review, and
// it is never marked verified.
export async function adminAddReview(env, body) {
  const slug = String(body?.slug ?? "").trim();
  const product = slug ? await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(slug).first() : null;
  if (!product) return bad("Unknown product.", 404);
  const c = cleanReview(body);
  if (c.error) return bad(c.error);
  const note = String(body?.source_note ?? "").replace(/\s+/g, " ").trim().slice(0, REVIEW_LIMITS.ownerNote);
  if (note.length < 3) return bad('Say where this review came from, e.g. "via WhatsApp".');
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO reviews (id, product_id, rating, name, body, verified, user_id, order_id, source, source_note, ip_hash, created_at)
     VALUES (?,?,?,?,?,0,NULL,NULL,'owner',?, '', ?)`
  ).bind(id, product.id, c.rating, c.name, c.body, note, now()).run();
  return json({ ok: true, id }, 201);
}
