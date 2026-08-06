// AswinPrints Worker — static assets (via ASSETS binding) + /api/* backend.
//
// Routing: anything matching a file in ./public is served by the ASSETS
// binding; everything else falls through to api(). Same shape as
// ~/projects/invoicer, which runs this config in production.

import { json, bad, isEmail, sendEmail } from "./lib.js";
import { withSecurityHeaders, rateLimit } from "./security.js";
import { isProductPath, productPage } from "./productpage.js";
import { quoteOwnerEmail, quoteCustomerEmail } from "./emails.js";
import { listProducts, priceCart } from "./shop.js";
// Aliased like the admin.js imports below: coupons.js exports its own CRUD names
// that would otherwise read ambiguously next to the product ones.
import {
  listCoupons as adminListCoupons, createCoupon as adminCreateCoupon,
  updateCoupon as adminUpdateCoupon, deleteCoupon as adminDeleteCoupon,
} from "./coupons.js";
import {
  createOrderHandler, verifyOrderHandler, getOrderHandler, razorpayWebhook,
} from "./orders.js";
// Admin/owner auth. Aliased on import because customers.js exports its own
// logout/whoami — two separate auth schemes, and the names must not blur.
import {
  providersResponse, loginStart, loginCallback,
  logout as ownerLogout, whoami as ownerWhoami, currentAdmin,
} from "./auth.js";
import {
  requestCode, verifyCode, resendCode, currentCustomer,
  whoami as customerWhoami, logout as customerLogout, myOrders, updateMe,
} from "./customers.js";
import { getCart, putCart, mergeCart } from "./cart.js";
import {
  listProducts as adminListProducts, createProduct as adminCreateProduct,
  updateProduct as adminUpdateProduct, deleteProduct as adminDeleteProduct,
  listOrders as adminListOrders, updateOrder as adminUpdateOrder,
  refundOrder as adminRefundOrder, stats as adminStats,
  bulkUpdateProducts as adminBulkUpdateProducts,
} from "./admin.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        // Rate limit before any handler runs, so a limited request costs us
        // nothing downstream — no D1 read, no Razorpay call, no email.
        const limited = await rateLimit(request, env, url);
        if (limited) return withSecurityHeaders(limited);

        const res = await api(request, env, url, ctx);
        return withSecurityHeaders(res);
      } catch (e) {
        // Deliberately generic. Invoicer returns `e.message` here, but these
        // routes talk to Razorpay and Resend, whose errors can echo request
        // detail back to the client. Log it, don't ship it.
        console.error("api error", url.pathname, e?.stack || e);
        return withSecurityHeaders(bad("Something went wrong. Please try again.", 500));
      }
    }
    // Shareable product links. Served by the Worker rather than the assets
    // binding because the Open Graph tags have to be per-product, and link
    // crawlers (WhatsApp, Slack, Facebook) do not run JavaScript — a preview is
    // built from the first HTML response, so this cannot be done client-side.
    if (isProductPath(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
      try {
        return withSecurityHeaders(await productPage(request, env, url));
      } catch (e) {
        // Never fail a shared link; fall back to the shop.
        console.error("product page error", url.pathname, e?.stack || e);
        return Response.redirect(new URL("/#shop", url.origin).toString(), 302);
      }
    }

    // Static assets get the headers too: the CSP only protects the pages if it
    // is on the HTML response itself, not just on the API JSON.
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // Routes needing the RAW body must be dispatched before anything parses it.
  // Razorpay's webhook HMAC is computed over the exact bytes sent, so
  // re-serialising a parsed object breaks verification.
  if (p === "/api/webhook/razorpay" && m === "POST") return razorpayWebhook(request, env, ctx);

  const body = (m === "POST" || m === "PUT" || m === "PATCH")
    ? await request.json().catch(() => ({}))
    : {};

  if (p === "/api/products" && m === "GET") return listProducts(env);

  // Orders. `/api/orders` takes {items:[{product_id,qty}], customer, delivery}
  // — never an amount; prices are read from D1 in priceCart().
  // Checkout works signed-in or as a guest. When signed in the order is stamped
  // with the session's user id so it appears in their history; the id comes from
  // the verified cookie, never from the request body.
  if (p === "/api/orders" && m === "POST") {
    const buyer = await currentCustomer(request, env);
    return createOrderHandler(request, env, body, buyer?.id || null);
  }
  if (p === "/api/orders/verify" && m === "POST") return verifyOrderHandler(request, env, body);

  const receiptMatch = p.match(/^\/api\/orders\/(AP-[0-9a-f]{8})$/);
  if (receiptMatch && m === "GET") return getOrderHandler(env, receiptMatch[1]);

  // Coupon preview, so checkout can show the discount before the customer pays.
  // Public by necessity — a guest must be able to apply a code — which makes it a
  // code-enumeration oracle, so it is rate limited in security.js. It reprices the
  // cart through priceCart rather than returning the coupon row: the customer
  // never needs to know a code is 15%-capped-at-₹200, only what it takes off THIS
  // cart, and returning the row would leak the whole coupon table one guess at a
  // time.
  if (p === "/api/coupon/check" && m === "POST") {
    const buyer = await currentCustomer(request, env);
    const priced = await priceCart(
      env, body?.items, "ship", body?.code ?? null,
      // Their own email if signed in; otherwise whatever the checkout form has so
      // far, for the once-per-customer check. Either way the real check happens
      // again at order time against the validated address.
      buyer?.email || clip(body?.email, 160),
    );
    if (priced.error) return bad(priced.error, 400);
    return json({
      ok: true,
      code: priced.coupon_code,
      subtotal_paise: priced.subtotal_paise,
      discount_paise: priced.discount_paise,
      shipping_paise: priced.shipping_paise,
      total_paise: priced.total_paise,
    });
  }

  if (p === "/api/quote" && m === "POST") return quote(request, env, ctx, body);
  if (p === "/api/health" && m === "GET") return json({ ok: true, app: env.APP_NAME });

  // ── auth (public: these are how you sign in) ────────────────────
  if (p === "/api/auth/providers" && m === "GET") return providersResponse(env);
  if (p === "/api/auth/me" && m === "GET") return ownerWhoami(request, env);
  if (p === "/api/auth/logout" && m === "POST") return ownerLogout();

  // ── customer sign-in (public: this is HOW you sign in) ──────────
  // Must stay above the /api/admin/* and /api/me/* gates.
  if (p === "/api/auth/code" && m === "POST") return requestCode(request, env, ctx, body);
  if (p === "/api/auth/code/verify" && m === "POST") return verifyCode(request, env, body);
  if (p === "/api/auth/code/resend" && m === "POST") return resendCode(request, env, ctx, body);

  // ── customer account ───────────────────────────────────────────
  // POSITIONAL GATE, same discipline as the admin block below: everything
  // inside is customer-only, and a route added ABOVE this line would be public.
  //
  // Note the handlers below receive `user` and never `url` — invariant 8. There
  // is no parameter by which one customer could ask for another's orders,
  // because the functions have nowhere to put one.
  if (p.startsWith("/api/me")) {
    const user = await currentCustomer(request, env);
    if (!user) return bad("unauthorized", 401);

    if (p === "/api/me" && m === "GET") {
      // Display hint only — see the note on whoami().
      return customerWhoami(user, Boolean(await currentAdmin(request, env)));
    }
    if (p === "/api/me" && m === "PATCH") return updateMe(env, user, body);
    if (p === "/api/me/logout" && m === "POST") return customerLogout();
    if (p === "/api/me/orders" && m === "GET") return myOrders(env, user);

    if (p === "/api/me/cart" && m === "GET") return getCart(env, user);
    if (p === "/api/me/cart" && m === "PUT") return putCart(env, user, body);
    if (p === "/api/me/cart/merge" && m === "POST") return mergeCart(env, user, body);

    return bad("not found", 404);
  }

  const loginMatch = p.match(/^\/api\/auth\/login\/([a-z]+)$/);
  if (loginMatch && m === "GET") return loginStart(env, loginMatch[1]);

  const cbMatch = p.match(/^\/api\/auth\/callback\/([a-z]+)$/);
  if (cbMatch && m === "GET") return loginCallback(env, cbMatch[1], request);

  // ── admin ──────────────────────────────────────────────────────
  // POSITIONAL GATE. Everything below this line is owner-only, and it works by
  // position: any /api/admin/* route added ABOVE it would be public. Keep new
  // admin routes below.
  if (p.startsWith("/api/admin/")) {
    // Either transport: a broker session, or an OTP-verified email that is on
    // the OWNER_EMAIL allowlist. Same allowlist check either way.
    const owner = await currentAdmin(request, env);
    if (!owner) return bad("unauthorized", 401);

    if (p === "/api/admin/stats" && m === "GET") return adminStats(env);

    if (p === "/api/admin/products" && m === "GET") return adminListProducts(env);
    if (p === "/api/admin/products" && m === "POST") return adminCreateProduct(env, body);
    // Bulk price/visibility pass. Plural path, so it can't collide with the
    // single-row /api/admin/products/:id below.
    if (p === "/api/admin/products" && m === "PATCH") return adminBulkUpdateProducts(env, body);

    const prod = p.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/);
    if (prod && m === "PATCH") return adminUpdateProduct(env, prod[1], body);
    if (prod && m === "DELETE") return adminDeleteProduct(env, prod[1]);

    if (p === "/api/admin/orders" && m === "GET") return adminListOrders(env, url);

    const ord = p.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})$/);
    if (ord && m === "PATCH") return adminUpdateOrder(env, ord[1], body);

    const refund = p.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/refund$/);
    if (refund && m === "POST") return adminRefundOrder(env, refund[1], body);

    if (p === "/api/admin/coupons" && m === "GET") return adminListCoupons(env);
    if (p === "/api/admin/coupons" && m === "POST") return adminCreateCoupon(env, body);

    const coup = p.match(/^\/api\/admin\/coupons\/([0-9a-f-]{36})$/);
    if (coup && m === "PATCH") return adminUpdateCoupon(env, coup[1], body);
    if (coup && m === "DELETE") return adminDeleteCoupon(env, coup[1]);

    return bad("not found", 404);
  }

  return bad("not found", 404);
}

// ── quote request ─────────────────────────────────────────────────
// Replaces the old flow, where the browser held a GitHub PAT (injected into
// main.js at deploy time) and fired a repository_dispatch to trigger a
// workflow that sent the mail. Anyone who viewed source could extract that
// token and trigger workflows. Now the secret is server-side only.

const MAX = { name: 100, email: 160, phone: 30, type: 60, desc: 3000, file: 300, ref: 300 };
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
    // Set when the request came from a gallery image or a product card. Free
    // text from the client, so it's clipped and escaped like any other field —
    // it is never used as a URL or a lookup key.
    ref_item: clip(b.ref_item, MAX.ref),
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
      + `Phone: ${q.phone || "not provided"}\nType: ${q.type}\nQty: ${q.qty}\n`
      + (q.ref_item ? `About: ${q.ref_item}\n` : "")
      + `\n${q.desc}\n`
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
