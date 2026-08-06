// Raise an invoice at invoicer.aswincloud.com when an order is paid.
//
// The shop's "Order confirmed" email is a RECEIPT — it confirms what happened.
// An invoice is a different document: it has a number, an issuer, a bill-to
// block, and it is the thing a customer keeps or files. Invoicer already renders
// and sends those, so this module's whole job is to hand it a paid order.
//
// ── Failure is silent, and loud in the logs ──────────────────────────────────
//
// This runs inside the Razorpay webhook, after the payment has already
// succeeded and the order is already marked paid. So the one thing it must never
// do is throw: an exception here would fail the webhook, Razorpay would retry,
// and a retry storm over an INVOICING outage would be a self-inflicted incident
// on the payment path.
//
// The customer's money is taken, their order is confirmed, and their confirmation
// email is on its way regardless. A missing invoice is a thing to fix on Monday;
// a wedged payment webhook is not.

import { now, hmacHex } from "./lib.js";

export async function sendOrderInvoice(env, order, items) {
  // Kill switch, checked first. One deploy stops invoicing without touching
  // Invoicer, and without any risk to the payment path.
  if (String(env.INVOICE_ENABLED ?? "").toLowerCase() !== "true") return;

  const url = env.INVOICER_URL;
  const secret = env.SHOP_INGEST_SECRET;
  if (!url || !secret) {
    console.error("invoicing not configured", { url: Boolean(url), secret: Boolean(secret) });
    return;
  }

  // Everything Invoicer needs, and nothing it does not.
  //
  // Amounts go over as INTEGER PAISE, the same units the shop stores and the same
  // units Razorpay charged. Converting to rupees here would introduce a float
  // before the number reaches the document that has to match a bank statement —
  // Invoicer does that conversion once, at the point of rendering.
  const payload = {
    ts: now(),
    receipt: order.receipt,
    paid_at: order.paid_at || now(),
    customer: {
      name: order.cust_name || "",
      email: order.cust_email || "",
      phone: order.cust_phone || "",
      addr_line: order.addr_line || "",
      addr_city: order.addr_city || "",
      addr_state: order.addr_state || "",
      addr_pin: order.addr_pin || "",
    },
    items: (items || []).map((it) => ({
      name: it.name,
      qty: it.qty,
      price_paise: it.price_paise,
    })),
    subtotal_paise: order.subtotal_paise,
    discount_paise: order.discount_paise || 0,
    shipping_paise: order.shipping_paise,
    total_paise: order.total_paise,
    coupon_code: order.coupon_code || null,
  };

  const raw = JSON.stringify(payload);

  try {
    // Signed over the exact bytes sent — the same scheme as the Razorpay webhook
    // this code runs inside, and as the chat-coupon endpoint. `raw` is passed as
    // the body verbatim rather than re-serialised, or the signature would cover
    // different bytes than the ones that arrive.
    const signature = await hmacHex(raw, secret);

    const res = await fetch(`${url.replace(/\/$/, "")}/api/ingest/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shop-signature": signature,
        // Cloudflare 403s the default fetch UA on some routes; the shop has been
        // bitten by this with Resend already.
        "User-Agent": "aswinprints-shop/1.0",
      },
      body: raw,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("invoice failed", order.receipt, res.status, JSON.stringify(body).slice(0, 200));
      return;
    }
    if (body.duplicate) {
      // A redelivered webhook. Expected, not a problem — logged so a flood of
      // them is visible.
      console.log("invoice already existed", order.receipt, body.number);
      return;
    }
    console.log("invoice raised", order.receipt, body.number, body.emailed ? "emailed" : "NOT emailed");
  } catch (e) {
    // Invoicer unreachable, DNS failure, timeout. Swallowed deliberately — see
    // the note at the top of this file.
    console.error("invoice error", order.receipt, e?.message || e);
  }
}
