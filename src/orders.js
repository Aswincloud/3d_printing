// Order creation, callback verification, receipt reads, and the Razorpay
// webhook — the whole paid path.
//
// The split of responsibility between the two inbound paths matters:
//
//   /api/orders/verify  — the BROWSER's word. Proves to us that the person
//                         looking at the screen completed checkout, so we can
//                         show them a receipt. Never writes `paid`.
//   /api/webhook/...    — RAZORPAY's word. The source of truth for fulfilment
//                         and for sending email. Fires even if the customer
//                         closes the tab mid-payment.
//
// If the browser could mark an order paid, anyone could POST a fabricated
// callback. And if only the browser could, a closed tab would lose the order.

import { json, bad, uid, now, randToken, isEmail, sendEmail } from "./lib.js";
import { priceCart } from "./shop.js";
import {
  createOrder, paymentsConfigured, publicKeyId,
  verifyCallbackSignature, verifyWebhookSignature,
} from "./razorpay.js";
import { orderCustomerEmail, orderOwnerEmail } from "./emails.js";

const MAX = { name: 100, email: 160, phone: 30, line: 200, city: 80, state: 80, pin: 10, notes: 500 };
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// ── customer details ──────────────────────────────────────────────
// Mirrors the client-side checks in main.js. The client's are for UX; these
// are the ones that count.
function validateCustomer(c, delivery) {
  const errors = [];
  const out = {
    cust_name: clip(c?.name, MAX.name),
    cust_email: clip(c?.email, MAX.email),
    cust_phone: clip(c?.phone, MAX.phone),
    addr_line: clip(c?.addr_line, MAX.line),
    addr_city: clip(c?.addr_city, MAX.city),
    addr_state: clip(c?.addr_state, MAX.state),
    addr_pin: clip(c?.addr_pin, MAX.pin),
    notes: clip(c?.notes, MAX.notes),
  };

  if (out.cust_name.length < 2) errors.push("Please enter your name.");
  if (!isEmail(out.cust_email)) errors.push("Please enter a valid email address.");
  // Phone is required for a physical order — it's how delivery gets arranged.
  if (out.cust_phone.replace(/\D/g, "").length < 10) {
    errors.push("Please enter a valid phone number.");
  }

  // Every order ships — local pickup was withdrawn, so there is no branch here
  // any more and an address is always required.
  if (out.addr_line.length < 5) errors.push("Please enter your street address.");
  if (!out.addr_city) errors.push("Please enter your city.");
  if (!out.addr_state) errors.push("Please enter your state.");
  if (!/^\d{6}$/.test(out.addr_pin)) errors.push("Please enter a valid 6-digit PIN code.");

  return { customer: out, errors };
}

// 'AP-' + 8 hex. Unguessable enough to act as the receipt-page key, and well
// under Razorpay's 40-char receipt cap.
const makeReceipt = () => "AP-" + randToken(4);

// ── POST /api/orders ──────────────────────────────────────────────
// Body: { items: [{product_id, qty}], customer: {...} }
//
// Note what is NOT in that list: any amount. The client cannot send a price,
// and if it does, priceCart() ignores it. `delivery` is also no longer read from
// the body — see below.
// `sessionUserId` is resolved by the router from the customer session cookie, or
// null for a guest. It is NOT read from the body: a request must not be able to
// attach its order to an arbitrary account.
export async function createOrderHandler(request, env, body, sessionUserId = null) {
  if (!paymentsConfigured(env)) {
    console.error("checkout attempted but Razorpay keys are unset");
    return bad("Online payment isn't set up yet. Please use the quote form.", 503);
  }

  // Hardcoded, NOT read from the body. Pickup used to be a checkout option and
  // shippingFor() returns 0 for it, so while the field was still honoured a
  // client could POST {delivery:"pickup"} and pay nothing for shipping while
  // supplying a full address — the same class of bug as sending your own price.
  // Removing the radio from the form would not have closed that; this does.
  const delivery = "ship";

  const { customer, errors } = validateCustomer(body?.customer, delivery);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  // Prices come from D1. This is the whole security model.
  const priced = await priceCart(env, body?.items, delivery);
  if (priced.error) return bad(priced.error, 400);

  const receipt = makeReceipt();
  const orderId = uid();

  const rzp = await createOrder(env, {
    amountPaise: priced.total_paise,
    receipt,
    notes: { order_id: orderId, receipt },
  });

  if (!rzp.ok) {
    // 401 is a config problem (bad keys), not the customer's fault. Log the
    // distinction; show them the same neutral message either way.
    if (rzp.status === 401) console.error("razorpay auth failed — check RAZORPAY_KEY_ID/SECRET");
    else console.error("razorpay order create failed", rzp.status, rzp.error);
    return bad("We couldn't start the payment. Please try again in a moment.", 502);
  }

  const ts = now();
  const batch = [
    env.DB.prepare(
      `INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise,
         shipping_paise, total_paise, currency, delivery, cust_name, cust_email,
         cust_phone, addr_line, addr_city, addr_state, addr_pin, notes, created_at,
         user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      orderId, receipt, rzp.order.id, "pending",
      priced.subtotal_paise, priced.shipping_paise, priced.total_paise, "INR", delivery,
      customer.cust_name, customer.cust_email, customer.cust_phone,
      customer.addr_line, customer.addr_city, customer.addr_state, customer.addr_pin,
      customer.notes, ts,
      // Null for a guest. Comes from the verified session, never from the body —
      // a request can't claim to belong to someone else's account.
      sessionUserId ?? null,
    ),
  ];

  for (const it of priced.items) {
    batch.push(env.DB.prepare(
      `INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, pos)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(uid(), orderId, it.product_id, it.name, it.price_paise, it.qty, it.pos));
  }

  await env.DB.batch(batch);

  // The browser needs the key id (public), the Razorpay order id, and the
  // amount to display. The amount is ours, not something it told us.
  return json({
    key_id: publicKeyId(env),
    rzp_order_id: rzp.order.id,
    amount: priced.total_paise,
    currency: "INR",
    receipt,
    subtotal_paise: priced.subtotal_paise,
    shipping_paise: priced.shipping_paise,
    total_paise: priced.total_paise,
    prefill: {
      name: customer.cust_name,
      email: customer.cust_email,
      contact: customer.cust_phone,
    },
  });
}

// ── POST /api/orders/verify ───────────────────────────────────────
// Confirms the callback really came from Razorpay so we can show a receipt.
// Deliberately does NOT set status='paid' — the webhook owns that.
export async function verifyOrderHandler(request, env, body) {
  const orderId = clip(body?.razorpay_order_id, 100);
  const paymentId = clip(body?.razorpay_payment_id, 100);
  const signature = clip(body?.razorpay_signature, 200);

  if (!orderId || !paymentId || !signature) {
    return bad("Missing payment details.", 400);
  }

  const valid = await verifyCallbackSignature(env, { orderId, paymentId, signature });
  if (!valid) {
    console.error("callback signature mismatch", { orderId, paymentId });
    return bad("Payment could not be verified.", 400);
  }

  const row = await env.DB.prepare(
    `SELECT id, receipt, status, total_paise FROM orders WHERE rzp_order_id = ?`
  ).bind(orderId).first();

  if (!row) {
    console.error("verified callback for an unknown order", orderId);
    return bad("Order not found.", 404);
  }

  // Record the payment id so the order is traceable even if the webhook is
  // slow or never arrives. Status stays 'pending' until the webhook says paid.
  await env.DB.prepare(
    `UPDATE orders SET rzp_payment_id = COALESCE(rzp_payment_id, ?) WHERE id = ?`
  ).bind(paymentId, row.id).run();

  return json({ ok: true, receipt: row.receipt, status: row.status });
}

// ── GET /api/orders/:receipt ──────────────────────────────────────
// Thank-you page data. The receipt is an unguessable token, which is what
// gates this — there's no login for customers.
export async function getOrderHandler(env, receipt) {
  const r = clip(receipt, 40);
  if (!/^AP-[0-9a-f]{8}$/.test(r)) return bad("Order not found.", 404);

  const order = await env.DB.prepare(
    `SELECT receipt, status, subtotal_paise, shipping_paise, total_paise,
            delivery, cust_name, created_at, paid_at
       FROM orders WHERE receipt = ?`
  ).bind(r).first();

  if (!order) return bad("Order not found.", 404);

  const { results } = await env.DB.prepare(
    `SELECT name, price_paise, qty FROM order_items
      WHERE order_id = (SELECT id FROM orders WHERE receipt = ?) ORDER BY pos`
  ).bind(r).all();

  return json({ order, items: results || [] });
}

// ── POST /api/webhook/razorpay ────────────────────────────────────
// Razorpay's word, and the only thing that marks an order paid.
//
// Called with the raw Request, before any body parsing: the HMAC covers the
// exact bytes sent, so `JSON.stringify(JSON.parse(raw))` would not verify.
export async function razorpayWebhook(request, env, ctx) {
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    console.error("webhook received but RAZORPAY_WEBHOOK_SECRET is unset");
    return bad("not configured", 503);
  }

  const valid = await verifyWebhookSignature(env, raw, signature);
  if (!valid) {
    console.error("webhook signature mismatch");
    return bad("invalid signature", 400);
  }

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return bad("bad payload", 400);
  }

  const eventId = request.headers.get("x-razorpay-event-id") || "";
  const eventType = evt?.event || "";

  // Idempotency. Delivery is at-least-once and unordered, so the same event
  // can arrive twice. The PK makes the second insert a no-op, and `meta.changes`
  // tells us whether this delivery was the first.
  if (eventId) {
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at)
       VALUES (?,?,?)`
    ).bind(eventId, eventType, now()).run();

    if (ins.meta?.changes === 0) {
      // Already handled. 200 so Razorpay stops retrying.
      return json({ ok: true, duplicate: true });
    }
  }

  // Fulfil on order.paid only. payment.captured fires alongside it and would
  // double-handle. order.paid's payload carries both entities, so there's no
  // second API call needed.
  if (eventType === "order.paid") {
    await handleOrderPaid(env, ctx, evt);
  } else if (eventType === "payment.failed") {
    // NOT terminal: Razorpay may still capture this payment after a UPI retry,
    // so the order stays 'pending' and just gets a note.
    const p = evt?.payload?.payment?.entity || {};
    console.warn("payment failed", p.order_id, p.error_description || "");
  }

  // Razorpay times out at ~5s, so return immediately; email goes out in the
  // background via ctx.waitUntil.
  return json({ ok: true });
}

async function handleOrderPaid(env, ctx, evt) {
  const rzpOrder = evt?.payload?.order?.entity || {};
  const payment = evt?.payload?.payment?.entity || {};
  const rzpOrderId = rzpOrder.id || payment.order_id;
  if (!rzpOrderId) return;

  const order = await env.DB.prepare(
    `SELECT * FROM orders WHERE rzp_order_id = ?`
  ).bind(rzpOrderId).first();

  if (!order) {
    console.error("order.paid for an unknown rzp order", rzpOrderId);
    return;
  }

  // Guard against a second transition even if the event id changed: only move
  // out of 'pending', and only send email if this UPDATE actually changed a row.
  const upd = await env.DB.prepare(
    `UPDATE orders SET status='paid', paid_at=?, rzp_payment_id=COALESCE(?, rzp_payment_id)
      WHERE id = ? AND status = 'pending'`
  ).bind(now(), payment.id || null, order.id).run();

  if (upd.meta?.changes === 0) return; // already paid — don't email twice

  const { results: items } = await env.DB.prepare(
    `SELECT name, price_paise, qty FROM order_items WHERE order_id = ? ORDER BY pos`
  ).bind(order.id).all();

  const paid = { ...order, status: "paid", rzp_payment_id: payment.id || order.rzp_payment_id };
  const owner = env.OWNER_EMAIL || "aswin@aswincloud.com";

  ctx.waitUntil(Promise.all([
    sendEmail(env, {
      to: paid.cust_email,
      replyTo: owner,
      subject: `Order confirmed — ${paid.receipt}`,
      html: orderCustomerEmail(env, paid, items || []),
      text: `Payment received. Your order ${paid.receipt} is confirmed.\n`,
    }).then((r) => { if (!r.ok) console.error("customer order email failed", r.status, r.error); }),

    sendEmail(env, {
      to: owner,
      replyTo: paid.cust_email,
      subject: `💰 New paid order — ${paid.receipt}`,
      html: orderOwnerEmail(env, paid, items || []),
      text: `New paid order ${paid.receipt} from ${paid.cust_name} <${paid.cust_email}>\n`,
    }).then((r) => { if (!r.ok) console.error("owner order email failed", r.status, r.error); }),
  ]));
}
