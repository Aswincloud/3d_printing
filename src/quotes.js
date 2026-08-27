// Quote requests: the record, and answering one with a price.
//
// A quote used to be two emails and nothing else. Now every request is a row, so
// there is a history, a status, and — the reason Aswin asked for this — one
// branded reply format instead of a hand-typed email each time.
//
// EVERY HANDLER HERE IS OWNER-ONLY. They are reached through the /api/admin gate
// in index.js and are deliberately absent from AGENT_ROUTES: this surface reads
// customer names, emails and phone numbers, and mints live payment links.

import { json, bad, uid, now, sendEmail } from "./lib.js";
import { createPaymentLink, paymentsConfigured, QUOTE_MIN_PAISE, QUOTE_MAX_PAISE } from "./razorpay.js";
import { quotationEmail } from "./emails.js";

const MAXLEN = { note: 3000 };
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

const STATUSES = new Set(["new", "replied", "paid", "won", "lost"]);

// Seven days. Long enough for someone to think about it over a weekend, short
// enough that a quoted price is not still payable next season.
const DEFAULT_EXPIRY_DAYS = 7;

// ── GET /api/admin/quotes ─────────────────────────────────────────
export async function listQuotes(env, url) {
  const status = String(url?.searchParams?.get("status") || "").trim();

  const where = STATUSES.has(status) ? "WHERE status = ?" : "";
  const binds = STATUSES.has(status) ? [status] : [];

  const { results } = await env.DB.prepare(
    `SELECT id, receipt, status, cust_name, cust_email, cust_phone, type, qty,
            description, ref_item, file_url, file_name, reply_note, quoted_paise,
            plink_url, plink_expires, order_id, created_at, replied_at
       FROM quotes ${where}
      ORDER BY created_at DESC
      LIMIT 200`
  ).bind(...binds).all();

  const rows = results || [];

  // A paid quote whose order has no delivery address needs chasing: a quote
  // request never asks for one, so the order it becomes starts blank. Surfaced
  // here rather than left for Aswin to notice when he goes to pack it.
  const orderIds = rows.map((r) => r.order_id).filter(Boolean);
  const needsAddress = new Set();
  if (orderIds.length) {
    const ph = orderIds.map(() => "?").join(",");
    const { results: os } = await env.DB.prepare(
      `SELECT id, receipt, addr_line FROM orders WHERE id IN (${ph})`
    ).bind(...orderIds).all();
    for (const o of os || []) if (!String(o.addr_line || "").trim()) needsAddress.add(o.id);
  }

  const { results: counts } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM quotes GROUP BY status`
  ).all();

  return json({
    quotes: rows.map((r) => ({ ...r, needs_address: needsAddress.has(r.order_id) })),
    counts: Object.fromEntries((counts || []).map((c) => [c.status, c.n])),
  });
}

// ── POST /api/admin/quotes/:id/reply ──────────────────────────────
// Prices the job, creates a Razorpay payment link, and sends the quotation.
export async function replyToQuote(env, id, body) {
  if (!paymentsConfigured(env)) {
    return bad("Payments aren't configured, so a payment link can't be created.", 503);
  }

  const q = await env.DB.prepare(`SELECT * FROM quotes WHERE id = ?`).bind(id).first();
  if (!q) return bad("Quote not found.", 404);

  // ONE LIVE LINK PER QUOTE. Without this a double-clicked Send leaves two
  // payable links for one job, and the second payment arrives with no way to
  // tell it from a real second order. The column is UNIQUE as well, so this is
  // belt and braces rather than the only guard.
  if (q.rzp_plink_id) {
    return bad("A payment link has already been sent for this quote.", 409);
  }

  // Rupees in, paise stored — same convention as the product editor, and the
  // same reason: nobody types paise.
  const rupees = Number(String(body?.amount_rupees ?? "").trim());
  if (!Number.isFinite(rupees) || rupees <= 0) return bad("Enter a valid amount.");
  const amountPaise = Math.round(rupees * 100);
  if (amountPaise < QUOTE_MIN_PAISE) return bad("The minimum is ₹1.");
  if (amountPaise > QUOTE_MAX_PAISE) {
    return bad("That amount looks wrong — the maximum is ₹5,00,000.");
  }

  const note = clip(body?.note, MAXLEN.note);
  const days = Math.max(1, Math.min(60, parseInt(body?.expiry_days, 10) || DEFAULT_EXPIRY_DAYS));
  const expiresAt = now() + days * 24 * 60 * 60 * 1000;

  const base = (env.APP_BASE_URL || "https://3d-prints.aswincloud.com").replace(/\/$/, "");
  const link = await createPaymentLink(env, {
    amountPaise,
    // The quote's receipt. The ONLY field of ours that comes back in the
    // payment_link.paid webhook, and therefore the only way a payment finds its
    // way home. See the webhook handler in orders.js.
    referenceId: q.receipt,
    description: `Custom 3D print — ${q.receipt}`,
    customer: { name: q.cust_name, email: q.cust_email, phone: q.cust_phone },
    expireBy: expiresAt,
    callbackUrl: `${base}/?quote=${encodeURIComponent(q.receipt)}`,
  });

  if (!link.ok) {
    console.error("payment link failed", q.receipt, link.status, link.error);
    return bad(link.error || "Razorpay wouldn't create the payment link.", 502);
  }

  const t = now();
  // Written BEFORE the email. If the mail fails we still hold the link, and the
  // alternative — mailing a link we have no record of — is the one outcome that
  // cannot be recovered from.
  await env.DB.prepare(
    `UPDATE quotes
        SET status = 'replied', reply_note = ?, quoted_paise = ?, rzp_plink_id = ?,
            plink_url = ?, plink_expires = ?, replied_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(note, amountPaise, link.link.id, link.link.short_url || "",
         expiresAt, t, t, id).run();

  const fresh = { ...q, reply_note: note, quoted_paise: amountPaise,
                  plink_url: link.link.short_url || "", plink_expires: expiresAt };

  const sent = await sendEmail(env, {
    to: q.cust_email,
    replyTo: env.OWNER_EMAIL || "aswin@aswincloud.com",
    subject: `Your quote — ${q.receipt}`,
    html: quotationEmail(env, fresh),
    text: `Hi ${q.cust_name},\n\n${note}\n\nYour price: ₹${(amountPaise / 100).toFixed(2)}\n`
      + (fresh.plink_url ? `\nPay here: ${fresh.plink_url}\n` : "")
      + `\n— Aswin\n${base}\n`,
  });

  // The link exists and is stored either way, so this is a warning rather than a
  // failure — Razorpay also emails the link, and Aswin can copy it from the card.
  if (!sent.ok) console.error("quotation email failed", q.receipt, sent.status, sent.error);

  return json({
    ok: true, emailed: sent.ok,
    quote: { ...fresh, status: "replied", replied_at: t },
  });
}

// ── PATCH /api/admin/quotes/:id ───────────────────────────────────
export async function updateQuoteStatus(env, id, body) {
  const status = clip(body?.status, 20);
  if (!STATUSES.has(status)) return bad("Unknown status.");

  // 'paid' is set by the webhook when money actually arrives, exactly as an
  // order cannot be marked paid from the dashboard. Same rule, same reason: the
  // status must never claim money moved when it did not.
  if (status === "paid") {
    return bad("Only a completed payment can mark a quote paid.", 400);
  }

  const row = await env.DB.prepare(`SELECT id, status FROM quotes WHERE id = ?`).bind(id).first();
  if (!row) return bad("Quote not found.", 404);
  if (row.status === "paid") return bad("This quote has been paid and cannot be reopened.", 409);

  await env.DB.prepare(`UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, now(), id).run();
  return json({ ok: true, status });
}
