// AswinPrints Worker — static assets (via ASSETS binding) + /api/* backend.
//
// Routing: anything matching a file in ./public is served by the ASSETS
// binding; everything else falls through to api(). Same shape as
// ~/projects/invoicer, which runs this config in production.

import { json, bad, isEmail, sendEmail } from "./lib.js";
import { quoteOwnerEmail, quoteCustomerEmail } from "./emails.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url, ctx);
      } catch (e) {
        // Deliberately generic. Invoicer returns `e.message` here, but these
        // routes talk to Razorpay and Resend, whose errors can echo request
        // detail back to the client. Log it, don't ship it.
        console.error("api error", url.pathname, e?.stack || e);
        return bad("Something went wrong. Please try again.", 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // Routes needing the RAW body must be dispatched before anything parses it.
  // Razorpay's webhook HMAC is computed over the exact bytes sent, so
  // re-serialising a parsed object breaks verification. (Phase 3.)
  // if (p === "/api/webhook/razorpay" && m === "POST") return razorpayWebhook(request, env, ctx);

  const body = (m === "POST" || m === "PUT" || m === "PATCH")
    ? await request.json().catch(() => ({}))
    : {};

  if (p === "/api/quote" && m === "POST") return quote(request, env, ctx, body);
  if (p === "/api/health" && m === "GET") return json({ ok: true, app: env.APP_NAME });

  return bad("not found", 404);
}

// ── quote request ─────────────────────────────────────────────────
// Replaces the old flow, where the browser held a GitHub PAT (injected into
// main.js at deploy time) and fired a repository_dispatch to trigger a
// workflow that sent the mail. Anyone who viewed source could extract that
// token and trigger workflows. Now the secret is server-side only.

const MAX = { name: 100, email: 160, phone: 30, type: 60, desc: 3000, file: 300 };
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// Mirrors the client-side validation in public/assets/js/main.js. The client
// checks are for UX; these are the ones that actually count.
function validateQuote(b) {
  const errors = [];
  const q = {
    name: clip(b.name, MAX.name),
    email: clip(b.email, MAX.email),
    phone: clip(b.phone, MAX.phone),
    type: clip(b.type, MAX.type),
    qty: Math.max(1, Math.min(1000, parseInt(b.qty, 10) || 0)),
    desc: clip(b.desc, MAX.desc),
    file_url: clip(b.file_url, MAX.file),
    file_name: clip(b.file_name, MAX.file),
  };

  if (q.name.length < 2) errors.push("Please enter your name.");
  if (!isEmail(q.email)) errors.push("Please enter a valid email address.");
  if (!q.type) errors.push("Please choose what you'd like printed.");
  if (q.desc.length < 10) errors.push("Please describe your project in a little more detail.");
  if (!b.qty || q.qty < 1) errors.push("Quantity must be at least 1.");

  // Only accept an https URL from the uploader — never echo arbitrary text
  // into a link in the owner's email.
  if (q.file_url && !/^https:\/\/[^\s"'<>]+$/.test(q.file_url)) {
    q.file_url = "";
    q.file_name = "";
  }
  return { q, errors };
}

async function quote(request, env, ctx, body) {
  const { q, errors } = validateQuote(body);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  if (!env.RESEND_API_KEY) {
    console.error("quote received but RESEND_API_KEY is unset");
    return bad("Email isn't configured yet. Please email aswin@aswincloud.com directly.", 503);
  }

  const owner = env.OWNER_EMAIL || "aswin@aswincloud.com";

  // The owner copy is the one that must not be lost, so it's awaited and its
  // result decides the response. The customer acknowledgement is best-effort.
  const sent = await sendEmail(env, {
    to: owner,
    replyTo: q.email,
    subject: `New Quote Request — ${q.name}`,
    html: quoteOwnerEmail(env, q),
    text: `New quote request from ${q.name} <${q.email}>\n`
      + `Phone: ${q.phone || "not provided"}\nType: ${q.type}\nQty: ${q.qty}\n\n${q.desc}\n`
      + (q.file_url ? `\nFile: ${q.file_name} — ${q.file_url}\n` : ""),
  });

  if (!sent.ok) {
    console.error("quote owner email failed", sent.status, sent.error);
    return bad("We couldn't send your request. Please try again, or email aswin@aswincloud.com.", 502);
  }

  ctx.waitUntil(sendEmail(env, {
    to: q.email,
    replyTo: owner,
    subject: "Got your quote request! — AswinPrints",
    html: quoteCustomerEmail(env, q),
    text: `Thanks, ${q.name}!\n\nI've received your quote request and will get back to you `
      + `within a few hours with pricing and details.\n\nType: ${q.type}\nQty: ${q.qty}\n\n`
      + `— Aswin\nhttps://3d-prints.aswincloud.com\n`,
  }).then((r) => {
    if (!r.ok) console.error("quote ack email failed", r.status, r.error);
  }));

  return json({ ok: true });
}
