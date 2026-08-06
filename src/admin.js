// Owner-only endpoints. Every handler here assumes the caller has ALREADY been
// authenticated by the positional gate in index.js — these functions never
// check auth themselves, so the gate must stay above them in the router.

import { json, bad, uid, now, sendEmail } from "./lib.js";
import { refundPayment, paymentsConfigured } from "./razorpay.js";
import { orderShippedEmail } from "./emails.js";

const MAXLEN = { name: 120, slug: 80, desc: 2000, image: 300, images: 2000, category: 40, note: 500,
  courier: 60, tracking: 80 };
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// Prices arrive from a form. Reject anything that isn't a whole number of
// paise: a float would round unpredictably at checkout, and a negative price
// would let a cart total go down as items are added.
function parsePaise(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

const slugify = (s) =>
  clip(s, MAXLEN.slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── products ──────────────────────────────────────────────────────
// Unlike the public /api/products, this returns hidden rows too — that's the
// point of the dashboard.
export async function listProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, name, description, price_paise, image, images, category,
            visible, sort, created_at, updated_at
       FROM products ORDER BY sort ASC, name ASC`
  ).all();
  return json({ products: results || [] });
}

export async function createProduct(env, body) {
  const name = clip(body?.name, MAXLEN.name);
  const price = parsePaise(body?.price_paise);
  const image = clip(body?.image, MAXLEN.image);

  if (name.length < 2) return bad("Name is required.");
  if (price === null) return bad("Price must be a whole number of paise (e.g. 34900 for ₹349).");
  if (!image) return bad("Image path is required.");

  const slug = slugify(body?.slug || name);
  if (!slug) return bad("Could not derive a slug from that name.");

  const dup = await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(slug).first();
  if (dup) return bad("A product with that slug already exists.", 409);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO products (id, slug, name, description, price_paise, image, images,
       category, visible, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, slug, name, clip(body?.description, MAXLEN.desc), price, image,
    clip(body?.images, MAXLEN.images), clip(body?.category, MAXLEN.category),
    body?.visible ? 1 : 0, parsePaise(body?.sort) ?? 0, ts, ts,
  ).run();

  return json({ ok: true, id, slug }, 201);
}

// PATCH semantics: only the fields present in the body are touched, so the
// dashboard can send just a price or just a visibility toggle.
export async function updateProduct(env, id, body) {
  const existing = await env.DB.prepare(`SELECT id FROM products WHERE id = ?`).bind(id).first();
  if (!existing) return bad("Product not found.", 404);

  const sets = [];
  const args = [];
  const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };

  if ("name" in body) {
    const name = clip(body.name, MAXLEN.name);
    if (name.length < 2) return bad("Name is too short.");
    put("name", name);
  }
  if ("price_paise" in body) {
    const price = parsePaise(body.price_paise);
    if (price === null) return bad("Price must be a whole number of paise.");
    put("price_paise", price);
  }
  if ("description" in body) put("description", clip(body.description, MAXLEN.desc));
  if ("image" in body) {
    const image = clip(body.image, MAXLEN.image);
    if (!image) return bad("Image path cannot be empty.");
    put("image", image);
  }
  if ("images" in body) put("images", clip(body.images, MAXLEN.images));
  if ("category" in body) put("category", clip(body.category, MAXLEN.category));
  if ("visible" in body) put("visible", body.visible ? 1 : 0);
  if ("sort" in body) {
    const sort = parsePaise(body.sort);
    if (sort === null) return bad("Sort must be a non-negative integer.");
    put("sort", sort);
  }
  if ("slug" in body) {
    const slug = slugify(body.slug);
    if (!slug) return bad("Slug cannot be empty.");
    const dup = await env.DB.prepare(
      `SELECT id FROM products WHERE slug = ? AND id != ?`
    ).bind(slug, id).first();
    if (dup) return bad("Another product already uses that slug.", 409);
    put("slug", slug);
  }

  if (!sets.length) return bad("Nothing to update.");

  put("updated_at", now());
  args.push(id);
  await env.DB.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();

  const row = await env.DB.prepare(
    `SELECT id, slug, name, description, price_paise, image, images, category,
            visible, sort, updated_at FROM products WHERE id = ?`
  ).bind(id).first();
  return json({ ok: true, product: row });
}

// ── bulk update ───────────────────────────────────────────────────
// PATCH /api/admin/products with [{id, price_paise?, visible?}].
//
// Exists because correcting the seeded placeholder prices meant 26 separate
// round trips through the single-row endpoint. Same validation as
// updateProduct(); only price and visibility are settable in bulk, since those
// are the two things a pricing pass actually changes.
//
// ALL-OR-NOTHING on purpose: every row is validated before anything is written.
// A partial write is the worst outcome here — you'd have no idea which of 26
// prices took, and re-submitting would double-apply nothing but would still
// leave you guessing. One bad row rejects the batch and names it.
export async function bulkUpdateProducts(env, body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return bad("Nothing to update.");
  }
  if (items.length > 200) return bad("Too many products in one request.");

  // Pass 1: validate and resolve. Nothing is written in this pass.
  const seen = new Set();
  const planned = [];
  for (const it of items) {
    const id = clip(it?.id, 40);
    if (!id) return bad("An item is missing its id.");
    if (seen.has(id)) return bad("The same product appears twice in one request.");
    seen.add(id);

    const sets = [];
    const args = [];

    if ("price_paise" in (it || {})) {
      const price = parsePaise(it.price_paise);
      if (price === null) {
        return bad(`Price for one item isn't a whole number of paise (got ${JSON.stringify(it.price_paise)}).`);
      }
      sets.push("price_paise = ?");
      args.push(price);
    }
    if ("visible" in (it || {})) {
      sets.push("visible = ?");
      args.push(it.visible ? 1 : 0);
    }
    if (!sets.length) return bad("An item has nothing to update.");

    planned.push({ id, sets, args });
  }

  // Confirm every id exists before touching anything — otherwise a typo'd id
  // would silently update nothing while reporting success.
  const ids = planned.map((p) => p.id);
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM products WHERE id IN (${ph})`
  ).bind(...ids).all();
  const found = new Set((results || []).map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) {
    return bad(`${missing.length} product(s) in this request no longer exist. Reload and try again.`, 409);
  }

  // Pass 2: write. batch() is a single D1 transaction, so a failure mid-way
  // rolls the whole thing back rather than leaving half the prices changed.
  const ts = now();
  const stmts = planned.map((p) => env.DB.prepare(
    `UPDATE products SET ${p.sets.join(", ")}, updated_at = ? WHERE id = ?`
  ).bind(...p.args, ts, p.id));

  await env.DB.batch(stmts);

  const { results: rows } = await env.DB.prepare(
    `SELECT id, slug, name, price_paise, visible FROM products WHERE id IN (${ph})`
  ).bind(...ids).all();

  return json({ ok: true, updated: planned.length, products: rows || [] });
}

// Deleting a product must never alter order history: order_items snapshots the
// name and price, and its product_id is nullable precisely so this can happen.
// It is NOT a cascade — the FK is on order_id, not product_id.
export async function deleteProduct(env, id) {
  const row = await env.DB.prepare(`SELECT id, name FROM products WHERE id = ?`).bind(id).first();
  if (!row) return bad("Product not found.", 404);

  const sold = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?`
  ).bind(id).first();

  // Hiding is almost always what's wanted for something already sold: it keeps
  // the row available for reporting while removing it from the shop.
  if ((sold?.n || 0) > 0) {
    await env.DB.prepare(`UPDATE products SET visible = 0, updated_at = ? WHERE id = ?`)
      .bind(now(), id).run();
    return json({
      ok: true, hidden: true, orders: sold.n,
      message: `"${row.name}" appears in ${sold.n} order line(s), so it was hidden rather than deleted. Order history is preserved.`,
    });
  }

  await env.DB.prepare(`DELETE FROM products WHERE id = ?`).bind(id).run();
  return json({ ok: true, deleted: true });
}

// ── orders ────────────────────────────────────────────────────────
const ORDER_STATUSES = ["pending", "paid", "failed", "shipped", "cancelled", "refunded"];

export async function listOrders(env, url) {
  const status = clip(url.searchParams.get("status"), 20);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 100));

  const where = ORDER_STATUSES.includes(status) ? `WHERE status = ?` : "";
  const bindArgs = where ? [status, limit] : [limit];

  const { results: orders } = await env.DB.prepare(
    `SELECT id, receipt, rzp_order_id, rzp_payment_id, status, subtotal_paise,
            discount_paise, coupon_code, shipping_paise, total_paise, delivery,
            cust_name, cust_email, cust_phone, addr_line, addr_city, addr_state,
            addr_pin, notes, created_at, paid_at, shipped_at, courier, tracking_id
       FROM orders ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...bindArgs).all();

  const list = orders || [];

  // One query for all line items rather than N+1.
  let items = [];
  if (list.length) {
    const ph = list.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT order_id, name, price_paise, qty, pos FROM order_items
        WHERE order_id IN (${ph}) ORDER BY pos`
    ).bind(...list.map((o) => o.id)).all();
    items = r.results || [];
  }

  const byOrder = new Map();
  for (const it of items) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push(it);
  }

  const { results: counts } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, SUM(total_paise) AS total FROM orders GROUP BY status`
  ).all();

  return json({
    orders: list.map((o) => ({ ...o, items: byOrder.get(o.id) || [] })),
    counts: counts || [],
  });
}

// Status transitions are restricted. 'paid' is deliberately NOT settable here:
// it's written by the webhook from Razorpay's confirmation, and letting the
// dashboard set it by hand would mean an unpaid order could be marked paid.
const ALLOWED_TRANSITIONS = {
  paid: ["shipped", "cancelled"],
  shipped: ["cancelled"],
  pending: ["cancelled"],
  failed: ["cancelled"],
};

export async function updateOrder(env, id, body, ctx = null) {
  // SELECT * because the shipped email needs the customer's name, email and
  // address, and listing them here would mean editing this query every time the
  // template wants another field.
  const order = await env.DB.prepare(
    `SELECT * FROM orders WHERE id = ?`
  ).bind(id).first();
  if (!order) return bad("Order not found.", 404);

  const sets = [];
  const args = [];
  let justShipped = false;

  if ("status" in body) {
    const next = clip(body.status, 20);
    if (!ORDER_STATUSES.includes(next)) return bad("Unknown status.");
    if (next === "paid") {
      return bad("An order is marked paid by Razorpay's webhook, not by hand.", 409);
    }
    if (next === "refunded") {
      return bad("Use the refund action so the money actually moves.", 409);
    }
    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (next !== order.status && !allowed.includes(next)) {
      return bad(`Cannot go from "${order.status}" to "${next}".`, 409);
    }
    sets.push("status = ?"); args.push(next);
    if (next === "shipped") {
      sets.push("shipped_at = ?"); args.push(now());
      // Only on the TRANSITION into shipped. Re-saving an order that is already
      // shipped — to correct a typo'd tracking number, say — must not send the
      // customer a second "your order has shipped" email.
      justShipped = order.status !== "shipped";
    }
  }

  if ("notes" in body) { sets.push("notes = ?"); args.push(clip(body.notes, MAXLEN.note)); }

  // Both optional, and both stored rather than only emailed: the tracking number
  // is what a customer asks about a week later, and it has to be findable then.
  if ("courier" in body) { sets.push("courier = ?"); args.push(clip(body.courier, MAXLEN.courier) || null); }
  if ("tracking_id" in body) { sets.push("tracking_id = ?"); args.push(clip(body.tracking_id, MAXLEN.tracking) || null); }

  if (!sets.length) return bad("Nothing to update.");

  args.push(id);
  await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();

  const row = await env.DB.prepare(
    `SELECT id, receipt, status, notes, shipped_at, courier, tracking_id FROM orders WHERE id = ?`
  ).bind(id).first();

  // Tell the customer. The confirmation email promises "I'll email you again when
  // it ships" — until now nothing kept that promise.
  //
  // Sent through waitUntil so a slow or failing Resend call does not hold up the
  // dashboard, and a failure is logged rather than surfaced: the order IS shipped
  // either way, and an error toast would suggest the status change did not stick.
  if (justShipped && env.RESEND_API_KEY) {
    const merged = { ...order, ...row };
    const send = sendEmail(env, {
      to: merged.cust_email,
      replyTo: env.OWNER_EMAIL || "aswin@aswincloud.com",
      subject: `Your order has shipped — ${merged.receipt}`,
      html: orderShippedEmail(env, merged, {
        courier: merged.courier,
        tracking: merged.tracking_id,
        trackingUrl: trackingUrlFor(merged.courier, merged.tracking_id),
      }),
      text: `Your order ${merged.receipt} has shipped.\n`
        + (merged.courier ? `Courier: ${merged.courier}\n` : "")
        + (merged.tracking_id ? `Tracking: ${merged.tracking_id}\n` : "")
        + `\n— Aswin\nhttps://3d-prints.aswincloud.com\n`,
    }).then((r) => {
      if (!r.ok) console.error("shipped email failed", merged.receipt, r.status, r.error);
    });
    if (ctx?.waitUntil) ctx.waitUntil(send); else await send;
  }

  return json({ ok: true, order: row, emailed: justShipped });
}

// A direct tracking link where the courier is one we can recognise, otherwise
// nothing — the email falls back to the receipt button.
//
// Deliberately a small allowlist rather than a guess at a url pattern: a wrong
// link is worse than none, because the customer clicks it, gets an error page,
// and concludes the parcel is lost. Matched loosely so "Blue Dart", "bluedart"
// and "BLUEDART courier" all resolve.
function trackingUrlFor(courier, tracking) {
  if (!courier || !tracking) return "";
  const key = String(courier).toLowerCase().replace(/[^a-z]/g, "");
  const id = encodeURIComponent(String(tracking).trim());
  if (key.includes("bluedart")) return `https://www.bluedart.com/tracking?trackingNo=${id}`;
  if (key.includes("delhivery")) return `https://www.delhivery.com/track/package/${id}`;
  if (key.includes("dtdc")) return `https://www.dtdc.in/tracking.asp?strCnno=${id}`;
  if (key.includes("indiapost") || key.includes("speedpost")) {
    return `https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx`;
  }
  if (key.includes("xpressbees")) return `https://www.xpressbees.com/shipment/tracking?awb=${id}`;
  if (key.includes("ecom")) return `https://ecomexpress.in/tracking/?awb_field=${id}`;
  return "";
}

// ── refunds ───────────────────────────────────────────────────────
// Real money. Guarded accordingly: only a paid/shipped order, only up to what
// was actually collected, and the local row is only updated after Razorpay
// confirms — so a failed refund never shows as refunded.
export async function refundOrder(env, id, body) {
  if (!paymentsConfigured(env)) return bad("Razorpay isn't configured.", 503);

  const order = await env.DB.prepare(
    `SELECT id, receipt, status, total_paise, rzp_payment_id FROM orders WHERE id = ?`
  ).bind(id).first();
  if (!order) return bad("Order not found.", 404);

  if (!order.rzp_payment_id) {
    return bad("This order has no payment to refund.", 409);
  }
  if (!["paid", "shipped"].includes(order.status)) {
    return bad(`Cannot refund an order with status "${order.status}".`, 409);
  }

  // Omit the amount for a full refund; otherwise partial.
  const requested = parsePaise(body?.amount_paise);
  if (body?.amount_paise !== undefined && requested === null) {
    return bad("Refund amount must be a whole number of paise.");
  }
  if (requested !== null && requested < 100) {
    return bad("Refund must be at least ₹1.");
  }
  if (requested !== null && requested > order.total_paise) {
    return bad(`Cannot refund more than the ₹${(order.total_paise / 100).toFixed(2)} collected.`);
  }

  const partial = requested !== null && requested < order.total_paise;

  const r = await refundPayment(env, order.rzp_payment_id, partial ? requested : undefined);
  if (!r.ok) {
    console.error("refund failed", order.receipt, r.status, JSON.stringify(r.body || {}));
    const desc = r.body?.error?.description;
    return bad(desc ? `Razorpay refused the refund: ${desc}` : "The refund could not be processed.", 502);
  }

  // Only a FULL refund changes the order's status; a partial one is recorded in
  // the notes so the order stays fulfilable.
  if (partial) {
    const note = `Partial refund of ₹${(requested / 100).toFixed(2)} (${r.refund?.id || "no id"}).`;
    await env.DB.prepare(
      `UPDATE orders SET notes = TRIM(COALESCE(notes,'') || ' ' || ?) WHERE id = ?`
    ).bind(note, id).run();
  } else {
    await env.DB.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).bind(id).run();
  }

  return json({
    ok: true,
    partial,
    refund_id: r.refund?.id || null,
    amount_paise: partial ? requested : order.total_paise,
  });
}

// ── dashboard summary ─────────────────────────────────────────────
export async function stats(env) {
  const paid = await env.DB.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS revenue
       FROM orders WHERE status IN ('paid','shipped')`
  ).first();
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`
  ).first();
  const products = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(visible),0) AS visible FROM products`
  ).first();
  return json({
    paid_orders: paid?.orders || 0,
    revenue_paise: paid?.revenue || 0,
    pending_orders: pending?.n || 0,
    products_total: products?.total || 0,
    products_visible: products?.visible || 0,
  });
}
