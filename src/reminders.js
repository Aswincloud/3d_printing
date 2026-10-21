// Automated reminders (2026-10-21).
//
//   unpaid — a checkout that is still unpaid 30 minutes after it was started.
//   cart   — a signed-in customer's cart left untouched for an hour.
//
// Each is ONE delayed Queue message, sent at the moment the thing happens
// (createOrderHandler, putCart/mergeCart). When it arrives the state is read
// once and the reminder is sent or skipped. Nothing polls and there is no cron.
//
// Every check happens at delivery time, not at scheduling time, because that is
// when it matters: an order paid in minute 29 must not get "you haven't paid";
// a cart changed in minute 59 is re-armed by the newer message, and the older
// one finds the cart has moved on and does nothing.
//
// What is sent, and why the coupon is where it is:
//   - Email always names COMEBACK (5% off, once per customer, ₹100 cap — those
//     limits live on the coupon row, not here). Its link is /back/<token>, which
//     rebuilds the cart and opens checkout with the code filled in. A pending
//     order cannot be repriced (its Razorpay order is fixed), so the discounted
//     path is a fresh checkout; the email also links the original /o/ page for
//     someone who would rather just pay what they were going to.
//   - WhatsApp naming a coupon is a MARKETING message to Meta, and only goes to
//     someone who ticked "send me offers on WhatsApp" (wa_offers). Everyone else
//     with an unpaid order gets the existing utility template with the plain pay
//     link; a cart reminder without consent is email only.
//   - Every reminder email BCCs the owner, like all customer mail.
//   - reminders_off (one-click unsubscribe in the email) stops both kinds.
import { sendEmail, ownerCopy, now, randToken, rupees, esc, trimSlashes } from "./lib.js";
import { sendPaymentReminder, sendComebackWhatsApp } from "./invoicing.js";

export const UNPAID_DELAY_S = 30 * 60;
export const CART_DELAY_S = 60 * 60;
export const COMEBACK_CODE = "COMEBACK";
// At most one cart reminder per customer in this window, however often the cart
// changes. Without it, clicking "Finish my order" and leaving again rewrites the
// cart and arms another reminder an hour later — every visit, forever.
export const CART_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

const site = (env) => trimSlashes(env.APP_BASE_URL || "https://3d-prints.aswincloud.com");

// Kill switch. Anything but "true" schedules nothing, and a message already in
// the queue does nothing when it arrives.
export const remindersOn = (env) => String(env.REMINDERS_ENABLED ?? "").toLowerCase() === "true";

// ── scheduling ────────────────────────────────────────────────────
// Never throws: a reminder must never fail a checkout or a cart save.
async function enqueue(env, body, delaySeconds) {
  if (!remindersOn(env) || !env.REMINDERS?.send) return false;
  try {
    await env.REMINDERS.send(body, { delaySeconds });
    return true;
  } catch (e) {
    console.error("could not schedule reminder", body.kind, e?.message || e);
    return false;
  }
}

export const scheduleUnpaidReminder = (env, orderId) =>
  enqueue(env, { kind: "unpaid", order_id: orderId }, UNPAID_DELAY_S);

// `stamp` is the cart's updated_at as written. The message carries it so that
// delivery can tell whether the cart has changed since — a newer change has its
// own message on the way.
export const scheduleCartReminder = (env, userId, stamp) =>
  enqueue(env, { kind: "cart", user_id: userId, stamp }, CART_DELAY_S);

// ── the queue consumer ────────────────────────────────────────────
export async function handleReminderBatch(batch, env) {
  for (const msg of batch.messages) {
    try {
      const b = msg.body || {};
      if (b.kind === "unpaid") await runUnpaid(env, b.order_id);
      else if (b.kind === "cart") await runCart(env, b.user_id, b.stamp);
      msg.ack();
    } catch (e) {
      // Retried by the queue (max_retries in wrangler.toml). Every send below is
      // guarded by a claim UPDATE, so a retry cannot send twice.
      console.error("reminder failed", msg.body?.kind, e?.message || e);
      msg.retry();
    }
  }
}

// ── unpaid checkout ───────────────────────────────────────────────
export async function runUnpaid(env, orderId) {
  if (!remindersOn(env)) return { sent: false, why: "off" };
  const o = await env.DB.prepare(
    `SELECT id, receipt, status, user_id, total_paise, cust_name, cust_email, cust_phone,
            pay_token, wa_offers, auto_reminder_at, pay_reminder_at, created_at
       FROM orders WHERE id = ?`).bind(orderId).first();
  if (!o) return { sent: false, why: "no such order" };
  if (o.status !== "pending") return { sent: false, why: "not pending" };
  if (o.pay_reminder_at) return { sent: false, why: "already reminded by hand" };

  // A newer order from the same person — paid or not — means they came back and
  // checked out again. Reminding them about the abandoned one would be noise.
  const newer = await env.DB.prepare(
    `SELECT 1 AS hit FROM orders WHERE lower(cust_email) = lower(?) AND created_at > ? AND id != ? LIMIT 1`)
    .bind(o.cust_email, o.created_at, o.id).first();
  if (newer) return { sent: false, why: "a newer order exists" };

  const prefs = await prefsFor(env, o.user_id, o.cust_email);
  if (prefs.off) return { sent: false, why: "unsubscribed" };

  // Claim before sending, so a queue retry or a second message cannot double up.
  const claim = await env.DB.prepare(
    `UPDATE orders SET auto_reminder_at = ? WHERE id = ? AND status = 'pending' AND auto_reminder_at IS NULL`)
    .bind(now(), o.id).run();
  if (!claim.meta?.changes) return { sent: false, why: "already reminded" };

  const { results } = await env.DB.prepare(
    `SELECT product_id, name, qty FROM order_items WHERE order_id = ? ORDER BY pos`).bind(o.id).all();
  const items = results || [];
  const back = await backLink(env, { userId: o.user_id, orderToken: o.pay_token });
  const what = itemsLabel(items);

  const mail = unpaidEmail(env, o, items, back);
  const r = await sendEmail(env, { to: o.cust_email, bcc: ownerCopy(env), replyTo: env.OWNER_EMAIL || undefined, ...mail })
    .catch((e) => ({ ok: false, error: e?.message }));
  if (!r.ok) console.error("unpaid reminder email failed", o.receipt, r.error);

  // WhatsApp: the offer for someone who opted in, else the plain utility reminder.
  let wa;
  if (o.cust_phone && (o.wa_offers || prefs.waOffers)) {
    wa = await sendComebackWhatsApp(env, { name: o.cust_name, phone: o.cust_phone, what, token: back.token });
  } else if (o.cust_phone && o.pay_token) {
    wa = await sendPaymentReminder(env, o);
  }
  if (wa && !wa.ok) console.error("unpaid reminder whatsapp not sent", o.receipt, wa.error);
  return { sent: true, email: Boolean(r.ok), whatsapp: wa ? Boolean(wa.ok) : null };
}

// ── abandoned cart ────────────────────────────────────────────────
export async function runCart(env, userId, stamp) {
  if (!remindersOn(env)) return { sent: false, why: "off" };
  const u = await env.DB.prepare(
    `SELECT id, email, name, phone, wa_offers, reminders_off, cart_reminded_at FROM users WHERE id = ?`)
    .bind(userId).first();
  if (!u) return { sent: false, why: "no such user" };
  if (u.reminders_off) return { sent: false, why: "unsubscribed" };

  const { results } = await env.DB.prepare(
    `SELECT c.product_id, c.qty, c.updated_at, p.name, p.price_paise
       FROM cart_items c JOIN products p ON p.id = c.product_id
      WHERE c.user_id = ? AND p.visible = 1 AND p.price_paise > 0
      ORDER BY c.updated_at`).bind(userId).all();
  const items = results || [];
  if (!items.length) return { sent: false, why: "cart empty" };

  // writeCart stamps every line with the same updated_at, so the newest line's
  // stamp is the cart's. A different one means the cart changed after this
  // message was scheduled, and the later message will handle it.
  const latest = Math.max(...items.map((i) => Number(i.updated_at) || 0));
  if (latest !== Number(stamp)) return { sent: false, why: "cart changed since" };

  // Ordered (checkout started, paid or not) since the cart was last touched: the
  // unpaid flow covers an unpaid one, and a paid one needs no nudge.
  const ordered = await env.DB.prepare(
    `SELECT 1 AS hit FROM orders WHERE (user_id = ? OR lower(cust_email) = lower(?)) AND created_at >= ? LIMIT 1`)
    .bind(u.id, u.email, latest).first();
  if (ordered) return { sent: false, why: "ordered since" };

  // Claimed before sending: cart_reminded_at is when the last reminder went, and
  // the conditional UPDATE is what stops a queue retry, a duplicate delivery, or
  // a second cart change inside the cooldown from sending another.
  const t = now();
  const claim = await env.DB.prepare(
    `UPDATE users SET cart_reminded_at = ? WHERE id = ? AND (cart_reminded_at IS NULL OR cart_reminded_at <= ?)`)
    .bind(t, u.id, t - CART_COOLDOWN_MS).run();
  if (!claim.meta?.changes) return { sent: false, why: "reminded recently" };

  const back = await backLink(env, { userId: u.id });
  const mail = cartEmail(env, u, items, back);
  const r = await sendEmail(env, { to: u.email, bcc: ownerCopy(env), replyTo: env.OWNER_EMAIL || undefined, ...mail })
    .catch((e) => ({ ok: false, error: e?.message }));
  if (!r.ok) console.error("cart reminder email failed", u.id, r.error);

  let wa = null;
  if (u.wa_offers && u.phone) {
    wa = await sendComebackWhatsApp(env, { name: u.name, phone: u.phone, what: itemsLabel(items), token: back.token });
    if (!wa.ok) console.error("cart reminder whatsapp not sent", u.id, wa.error);
  }
  return { sent: true, email: Boolean(r.ok), whatsapp: wa ? Boolean(wa.ok) : null };
}

// ── helpers ───────────────────────────────────────────────────────

// A guest's preferences come from their account if the email has one — someone
// who unsubscribed while signed in must not be reminded as a guest.
async function prefsFor(env, userId, email) {
  const u = userId
    ? await env.DB.prepare(`SELECT wa_offers, reminders_off FROM users WHERE id = ?`).bind(userId).first()
    : await env.DB.prepare(`SELECT wa_offers, reminders_off FROM users WHERE lower(email) = lower(?)`).bind(email || "").first();
  return { waOffers: Boolean(u?.wa_offers), off: Boolean(u?.reminders_off) };
}

// The token the /back/ link carries. For an account it is the user's back_token
// (minted once, reused); for a guest's unpaid order it is the order's pay_token,
// prefixed so the two can never be confused.
async function backLink(env, { userId, orderToken }) {
  if (userId) {
    let row = await env.DB.prepare(`SELECT back_token FROM users WHERE id = ?`).bind(userId).first();
    if (!row?.back_token) {
      await env.DB.prepare(`UPDATE users SET back_token = ? WHERE id = ? AND back_token IS NULL`)
        .bind(randToken(16), userId).run();
      row = await env.DB.prepare(`SELECT back_token FROM users WHERE id = ?`).bind(userId).first();
    }
    const token = "u" + row.back_token;
    return { token, url: `${site(env)}/back/${token}`, unsub: `${site(env)}/back/${token}/stop` };
  }
  const token = "o" + orderToken;
  return { token, url: `${site(env)}/back/${token}`, unsub: `${site(env)}/back/${token}/stop` };
}

// "Murugan Vibhuti Box", "Murugan Vibhuti Box and 2 more items". Product names
// are owner-written, but go into a WhatsApp template parameter, which Meta
// rejects with newlines, tabs or 4+ spaces — so whitespace is collapsed.
export function itemsLabel(items) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!items.length) return "your items";
  const first = clean(items[0].name) || "your item";
  const more = items.length - 1;
  return more > 0 ? `${first} and ${more} more item${more === 1 ? "" : "s"}` : first;
}

const STYLE = {
  wrap: "font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111",
  btn: "display:inline-block;background:#ff6b00;color:#fff;padding:12px 26px;border-radius:8px;font-weight:700;text-decoration:none",
  code: "display:inline-block;border:2px dashed #ff6b00;padding:6px 14px;border-radius:6px;font-weight:700;letter-spacing:1px;color:#b45309",
  muted: "color:#666;font-size:13px",
};

function list(items) {
  return `<ul style="padding-left:18px;margin:12px 0">${items.map((i) =>
    `<li>${esc(i.name)} × ${Number(i.qty) || 1}</li>`).join("")}</ul>`;
}

function offerBlock(env, back) {
  return `<p style="margin:18px 0 6px">Here's 5% off to finish it:</p>
    <p style="margin:0 0 18px"><span style="${STYLE.code}">${COMEBACK_CODE}</span></p>
    <p><a href="${esc(back.url)}" style="${STYLE.btn}">Finish my order</a></p>
    <p style="${STYLE.muted}">The button puts your items back in the cart with the code filled in. One use per customer, up to ₹100 off.</p>`;
}

function footer(back) {
  return `<p style="${STYLE.muted};margin-top:28px">Questions? Just reply to this email.<br>
    Don't want reminders like this? <a href="${esc(back.unsub)}">Stop them</a>.</p>`;
}

export function unpaidEmail(env, o, items, back) {
  const name = String(o.cust_name || "").trim() || "there";
  const payUrl = o.pay_token ? `${site(env)}/o/${o.pay_token}` : "";
  return {
    subject: `Your order ${o.receipt} is waiting — 5% off to finish it`,
    text: `Hi ${name},\n\nYour order ${o.receipt} (${rupees(o.total_paise)}) hasn't been paid yet.\n\n` +
      items.map((i) => `- ${i.name} x ${i.qty}`).join("\n") +
      `\n\nUse code ${COMEBACK_CODE} for 5% off: ${back.url}\n` +
      (payUrl ? `Or pay the original amount: ${payUrl}\n` : "") +
      `\nStop these reminders: ${back.unsub}\n`,
    html: `<div style="${STYLE.wrap}">
      <h2 style="margin:0 0 8px">Your order is waiting, ${esc(name)}</h2>
      <p>Order <strong>${esc(o.receipt)}</strong> for ${esc(rupees(o.total_paise))} hasn't been paid yet.</p>
      ${list(items)}
      ${offerBlock(env, back)}
      ${payUrl ? `<p style="${STYLE.muted}">Or <a href="${esc(payUrl)}">pay the original amount</a> without the code.</p>` : ""}
      ${footer(back)}
    </div>`,
  };
}

export function cartEmail(env, u, items, back) {
  const name = String(u.name || "").trim() || "there";
  return {
    subject: "You left something in your cart — 5% off inside",
    text: `Hi ${name},\n\nYou left these in your cart at ${env.APP_NAME || "AswinPrints"}:\n\n` +
      items.map((i) => `- ${i.name} x ${i.qty}`).join("\n") +
      `\n\nUse code ${COMEBACK_CODE} for 5% off: ${back.url}\n\nStop these reminders: ${back.unsub}\n`,
    html: `<div style="${STYLE.wrap}">
      <h2 style="margin:0 0 8px">Still thinking it over, ${esc(name)}?</h2>
      <p>You left these in your cart:</p>
      ${list(items)}
      ${offerBlock(env, back)}
      ${footer(back)}
    </div>`,
  };
}

// ── /back/<token> ─────────────────────────────────────────────────
// Rebuilds the cart in the browser and opens checkout with COMEBACK filled in.
// The page carries only product ids and quantities — the shop prices everything
// at checkout as always, so the token grants nothing but "these were your items".
// "u…" is an account's back_token; "o…" is a guest order's pay_token.
const BACK_RE = /^([uo])([0-9a-f]{32})$/;

async function resolveBack(env, token) {
  const m = BACK_RE.exec(String(token || ""));
  if (!m) return null;
  if (m[1] === "u") {
    const u = await env.DB.prepare(`SELECT id, email FROM users WHERE back_token = ?`).bind(m[2]).first();
    if (!u) return null;
    const { results } = await env.DB.prepare(
      `SELECT c.product_id, c.qty, c.personalisation FROM cart_items c JOIN products p ON p.id = c.product_id
        WHERE c.user_id = ? AND p.visible = 1 ORDER BY c.updated_at`).bind(u.id).all();
    let items = results || [];
    // An account whose reminder was about an unpaid order may have an empty
    // cart (checkout cleared nothing, but a cart can be emptied by hand). Fall
    // back to their latest pending order's lines.
    if (!items.length) {
      const o = await env.DB.prepare(
        `SELECT id FROM orders WHERE (user_id = ? OR lower(cust_email) = lower(?)) AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`).bind(u.id, u.email).first();
      if (o) items = await orderLines(env, o.id);
    }
    return { kind: "user", id: u.id, items };
  }
  const o = await env.DB.prepare(`SELECT id, cust_email FROM orders WHERE pay_token = ?`).bind(m[2]).first();
  if (!o) return null;
  return { kind: "order", id: o.id, email: o.cust_email, items: await orderLines(env, o.id) };
}

async function orderLines(env, orderId) {
  const { results } = await env.DB.prepare(
    `SELECT oi.product_id, oi.qty, oi.personalisation FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND p.visible = 1 ORDER BY oi.pos`).bind(orderId).all();
  return results || [];
}

export async function backPage(env, token) {
  const r = await resolveBack(env, token);
  if (!r) return backHtml("Link not found", `<p>This link isn't valid any more.</p><p><a href="/#shop">Go to the shop</a></p>`, 404);
  const cart = r.items.map((i) => ({ id: i.product_id, qty: Math.max(1, Math.min(100, Number(i.qty) || 1)), pz: String(i.personalisation || "").slice(0, 120) }));
  if (!cart.length) return backHtml("Nothing to restore", `<p>Those items aren't available any more.</p><p><a href="/#shop">See what's in the shop</a></p>`);
  // `own` is true only for an account's link: the cart it carries IS that
  // account's cart, so on sign-in it may replace the server copy. A guest order's
  // link must merge like any guest cart, or it would wipe an account's saved items.
  const cfg = esc(JSON.stringify({ cart, code: COMEBACK_CODE, own: r.kind === "user" }));
  return backHtml("Taking you to checkout…",
    `<p id="back" data-cfg="${cfg}">Putting your items back in the cart…</p>
     <noscript><p>Turn on JavaScript, or <a href="/#shop">go to the shop</a> and use code ${COMEBACK_CODE}.</p></noscript>
     <script src="/assets/js/back.js" defer></script>`);
}

export async function stopReminders(env, token) {
  const r = await resolveBack(env, token);
  if (!r) return backHtml("Link not found", `<p>This link isn't valid any more.</p>`, 404);
  if (r.kind === "user") {
    await env.DB.prepare(`UPDATE users SET reminders_off = 1, wa_offers = 0 WHERE id = ?`).bind(r.id).run();
  } else {
    // A guest has no account to hold the preference; this order stops here, and
    // an account later created with the same email starts with reminders on.
    await env.DB.prepare(`UPDATE orders SET auto_reminder_at = COALESCE(auto_reminder_at, ?), wa_offers = 0 WHERE id = ?`)
      .bind(now(), r.id).run();
    await env.DB.prepare(`UPDATE users SET reminders_off = 1, wa_offers = 0 WHERE lower(email) = lower(?)`)
      .bind(r.email || "").run();
  }
  return backHtml("Reminders stopped", `<p>Done — you won't get reminder emails or offers from us.</p><p><a href="/">Back to the shop</a></p>`);
}

// GET of the unsubscribe link: a button, not the action. Mail security scanners
// and chat link previews fetch every URL in a message, and a GET that changed
// state would unsubscribe people who never clicked.
export function stopConfirmPage(token) {
  if (!BACK_RE.test(String(token || ""))) return backHtml("Link not found", `<p>This link isn't valid any more.</p>`, 404);
  return backHtml("Stop reminders?", `<p>You won't get cart or payment reminder emails, or offers on WhatsApp. Order confirmations and delivery updates still come as usual.</p>
    <form method="post" action="/back/${token}/stop"><button type="submit" style="min-height:44px;padding:10px 20px;font-weight:700;background:#ff6b00;color:#111;border:0;border-radius:10px;cursor:pointer">Stop reminders</button></form>`);
}

function backHtml(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — AswinPrints</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>:root{color-scheme:dark}body{margin:0;background:#0b0b10;color:#f4f4f5;font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:460px;margin:0 auto;padding:48px 16px}a{color:#ff8c38}</style></head>
<body><main><h1 style="font-size:1.4rem">${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
}
