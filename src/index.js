// AswinPrints Worker — static assets (via ASSETS binding) + /api/* backend.
//
// Routing: anything matching a file in ./public is served by the ASSETS
// binding; everything else falls through to api(). Same shape as
// ~/projects/invoicer, which runs this config in production.

import { json, bad, isEmail, sendEmail, now } from "./lib.js";
import { withSecurityHeaders, rateLimit } from "./security.js";
import { isProductPath, productPage } from "./productpage.js";
import { sitemap, robots, rewriteHome, localPageJsonLd, jsonLdScript } from "./seo.js";
import { quoteOwnerEmail, quoteCustomerEmail } from "./emails.js";
import { listProducts, priceCart } from "./shop.js";
// Aliased like the admin.js imports below: coupons.js exports its own CRUD names
// that would otherwise read ambiguously next to the product ones.
import {
  listCoupons as adminListCoupons, createCoupon as adminCreateCoupon,
  updateCoupon as adminUpdateCoupon, deleteCoupon as adminDeleteCoupon,
  couponRedemptions as adminCouponRedemptions,
} from "./coupons.js";
import { chatCouponHandler } from "./chatcoupons.js";
import { listQuotes, replyToQuote, updateQuoteStatus } from "./quotes.js";
import { agentVerdict } from "./agent.js";
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
  unlistedImages as adminUnlistedImages,
  batchCreateProducts as adminBatchCreate, hideImages as adminHideImages,
  describeProducts as adminDescribe,
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
        return withSecurityHeaders(noStoreUnlessCacheable(url, res));
      } catch (e) {
        // Deliberately generic. Invoicer returns `e.message` here, but these
        // routes talk to Razorpay and Resend, whose errors can echo request
        // detail back to the client. Log it, don't ship it.
        console.error("api error", url.pathname, e?.stack || e);
        return withSecurityHeaders(bad("Something went wrong. Please try again.", 500));
      }
    }
    // ── search engines ────────────────────────────────────────────
    //
    // Public by necessity: a crawler has no session. Above every auth gate, and
    // deliberately serving nothing an anonymous visitor could not already see —
    // the sitemap lists only visible, priced products.
    if (url.pathname === "/sitemap.xml" && (request.method === "GET" || request.method === "HEAD")) {
      try {
        return withSecurityHeaders(await sitemap(env));
      } catch (e) {
        console.error("sitemap error", e?.stack || e);
        return withSecurityHeaders(new Response("", { status: 500 }));
      }
    }
    if (url.pathname === "/robots.txt" && (request.method === "GET" || request.method === "HEAD")) {
      return withSecurityHeaders(robots(env));
    }

    // Google Search Console's HTML-file verification. Serves the token only when
    // GOOGLE_SITE_VERIFICATION is set and the filename matches it exactly, so
    // this is inert until Aswin pastes his token into wrangler.toml — no code
    // change needed then.
    const gsv = String(env.GOOGLE_SITE_VERIFICATION || "").trim();
    if (gsv && url.pathname === `/google${gsv}.html`) {
      return withSecurityHeaders(new Response(`google-site-verification: google${gsv}.html`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
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

    // The local landing page gets LocalBusiness + FAQ structured data.
    //
    // Injected here rather than baked into the generated HTML so the address,
    // phone and business name come from one place (src/seo.js) — the same values
    // the homepage and product pages use. Two copies of an address is how they
    // end up disagreeing.
    if ((url.pathname === "/3d-printing-in-pondicherry"
         || url.pathname === "/3d-printing-in-pondicherry.html")
        && (request.method === "GET" || request.method === "HEAD")) {
      const page = await env.ASSETS.fetch(request);
      try {
        const canonical = (env.APP_BASE_URL || "https://3d-prints.aswincloud.com")
          .replace(/\/$/, "") + "/3d-printing-in-pondicherry";
        const out = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.append(
                `<link rel="canonical" href="${canonical}" />`
                + jsonLdScript(localPageJsonLd(env)),
                { html: true },
              );
            },
          })
          .transform(page);
        return withSecurityHeaders(out);
      } catch (e) {
        console.error("local page rewrite failed", e?.message || e);
        return withSecurityHeaders(page);
      }
    }

    // The homepage, with the catalogue rendered into the HTML.
    //
    // Without this a crawler receives a page containing no product: the grid is
    // filled by JavaScript. Google does run JS, but on a slower second pass that
    // is not guaranteed, and most other crawlers do not run it at all.
    //
    // Wrapped and non-fatal. This is a crawler optimisation on the page every
    // visitor loads, so a D1 error must serve the page unchanged rather than
    // fail it — same discipline as the product-page fallback above.
    if ((url.pathname === "/" || url.pathname === "/index.html")
        && (request.method === "GET" || request.method === "HEAD")) {
      const page = await env.ASSETS.fetch(request);
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, name, description, price_paise, image
             FROM products WHERE visible = 1 ORDER BY sort ASC, name ASC`
        ).all();

        const rendered = rewriteHome(env, page, results || [], url);

        // Edge-cached, because this added a D1 query to the hot path.
        //
        // Measured: TTFB went from ~6ms to ~12ms with the query, and the
        // homepage is the one page every visitor loads. s-maxage lets
        // Cloudflare serve the rendered HTML from the edge so the origin runs
        // the query once per minute rather than once per visitor.
        //
        // 60s, not longer: prices and visibility are edited in the dashboard and
        // the change should show up while Aswin is still looking at it. Same
        // trade-off as the product page, which uses 300s for the same reason.
        return withSecurityHeaders(new Response(rendered.body, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
            "cdn-cache-control": "public, s-maxage=60",
          },
        }));
      } catch (e) {
        console.error("home render failed, serving plain", e?.message || e);
        return withSecurityHeaders(page);
      }
    }

    // Static assets get the headers too: the CSP only protects the pages if it
    // is on the HTML response itself, not just on the API JSON.
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

// Which /api/ responses may be stored by a shared cache. An ALLOWLIST, not a
// blocklist, and this is the second attempt at it.
//
// The first was per-endpoint: /api/me states `private, no-store` at its return, and
// when [cache] was enabled in wrangler.toml I audited the API surface and added it
// there. I missed /api/auth/me — a different endpoint answering the same question —
// and Cloudflare cached `{"signedIn":false}` for everyone. Aswin signed in
// successfully, the page asked who he was, the edge handed back a 20-minute-old
// "nobody", and he was returned to the sign-in screen every time.
//
// It was also a latent disclosure, not just an annoyance: had the first request
// after an eviction come from a signed-in session, that response — carrying an email
// address — would have been stored and served to strangers.
//
// So the default is inverted. Everything under /api/ is no-store unless it appears
// here, which means a new endpoint is private until someone deliberately decides
// otherwise, rather than public until someone remembers.
//
// A MAP OF SECONDS, not a set of paths — the third attempt, and the reason is the
// second one's bug. Membership alone said "this may be cached" and nothing said for
// how long, so the entry was returned untouched and Cloudflare applied its own
// default of two hours. Aswin listed four photos as products, the dashboard
// confirmed the write, and the shop kept serving them as unpriced quote-only cards
// for the rest of the afternoon. Nothing was broken; the edge simply had not been
// told anything, and an unstated TTL is not "no caching", it is somebody else's.
//
// Now a path cannot be made cacheable without stating its lifetime in the same
// breath.
const CACHEABLE_API = new Map([
  // The public catalogue; identical for everyone, so worth caching — but it is
  // exactly what the dashboard edits, so a minute is the ceiling. That is still
  // enough to collapse a burst into one D1 query, which is all the cache was for.
  // It matches the homepage and sits under the product page's 300s.
  ["/api/products", 60],
]);

function noStoreUnlessCacheable(url, res) {
  const ttl = CACHEABLE_API.get(url.pathname);

  // res.ok as well as membership. A 500 from the catalogue handler is still a
  // response on a cacheable path, and without this the edge would pin the outage in
  // place for the full TTL and keep serving it after the origin recovered.
  if (ttl !== undefined && res.ok) {
    // Unless the handler already stated an edge policy of its own.
    if (res.headers.get("cdn-cache-control")) return res;
    const h = new Headers(res.headers);
    // Split deliberately: browsers revalidate every time, the edge holds it for the
    // TTL. A shared cache is safe to serve stale here for a minute; a customer's own
    // browser showing them a stale price after they reloaded is not.
    h.set("cache-control", "public, max-age=0, must-revalidate");
    h.set("cdn-cache-control", `public, s-maxage=${ttl}`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }

  // Only set it if the handler did not already say something deliberate.
  if (res.headers.get("cache-control")) return res;
  const h = new Headers(res.headers);
  h.set("cache-control", "private, no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // Routes needing the RAW body must be dispatched before anything parses it.
  // Razorpay's webhook HMAC is computed over the exact bytes sent, so
  // re-serialising a parsed object breaks verification.
  if (p === "/api/webhook/razorpay" && m === "POST") return razorpayWebhook(request, env, ctx);

  // Same reason: the chat bot signs the exact bytes it sends. This route is
  // service-to-service and carries its OWN auth (HMAC + a timestamp replay
  // window) rather than sitting behind the owner or customer gates below — it is
  // called by the bot container, which is neither.
  if (p === "/api/chat/coupon" && m === "POST") return chatCouponHandler(request, env);

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

    // "Who am I?" has a correct answer for a signed-out visitor, and it is
    // "nobody" — not an error. Every page calls this on load to decide whether
    // to show the account menu, so a 401 meant every visitor who is not signed
    // in generated a failed request and a red console line on every page view.
    //
    // Only GET /api/me. Everything else under /api/me/ asks for something that
    // belongs to a specific person — orders, the saved cart, an address — and
    // for those "nobody" is a genuine 401, so they fall through to the gate
    // below. This branch discloses nothing: the body is exactly {signedIn:false}
    // and the session cookie is HttpOnly, so this is the only way the page can
    // find out, and the answer is one it is entitled to.
    if (!user && p === "/api/me" && m === "GET") {
      return json({ signedIn: false }, 200, { "cache-control": "private, no-store" });
    }

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

    // Second actor: the listing agent, which holds a token authorising exactly two
    // routes. Checked only when there is no owner session, so nothing about the
    // owner path changes — and `actor` is threaded to the batch handler so it can
    // apply the tighter limits in agent.js rather than trusting the caller.
    let actor = owner ? "owner" : null;
    if (!owner) {
      const verdict = await agentVerdict(request, env, m, p);
      if (verdict === "agent") actor = "agent";
      // A valid token on a route it does not cover is 403, not 401: the credential
      // was accepted, the action was not. 401 would invite the agent to retry with
      // different credentials it does not have, and hide a real misconfiguration.
      else if (verdict === "forbidden") {
        console.warn(`agent token denied: ${m} ${p}`);
        return bad("This token may only read unlisted photos and create new listings.", 403);
      }
    }
    if (!actor) return bad("unauthorized", 401);

    if (p === "/api/admin/stats" && m === "GET") return adminStats(env);

    if (p === "/api/admin/products" && m === "GET") return adminListProducts(env);
    if (p === "/api/admin/products" && m === "POST") return adminCreateProduct(env, body);
    // Bulk price/visibility pass. Plural path, so it can't collide with the
    // single-row /api/admin/products/:id below.
    if (p === "/api/admin/products" && m === "PATCH") return adminBulkUpdateProducts(env, body);

    // Photos in the repo that no product points at yet — what Aswin just pushed
    // and has not priced. Above the /:id route below: that pattern only matches
    // a 36-char uuid so there is no real collision, but a literal path sitting
    // under a wildcard is the kind of thing that becomes one later.
    if (p === "/api/admin/products/unlisted" && m === "GET") return adminUnlistedImages(env);
    // List several photos at one price, or take photos out of the shop. Both
    // write a row per image in a single transaction — see the note in admin.js.
    if (p === "/api/admin/products/batch" && m === "POST") return adminBatchCreate(env, body, actor, ctx);
    // Sibling of batch: same actor, same ctx, and the only agent route that writes
    // to a row it did not create. Its WHERE clause is what makes that safe.
    if (p === "/api/admin/products/describe" && m === "POST") return adminDescribe(env, body, actor, ctx);
    if (p === "/api/admin/products/hide" && m === "POST") return adminHideImages(env, body);

    const prod = p.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/);
    if (prod && m === "PATCH") return adminUpdateProduct(env, prod[1], body);
    if (prod && m === "DELETE") return adminDeleteProduct(env, prod[1]);

    if (p === "/api/admin/orders" && m === "GET") return adminListOrders(env, url);

    const ord = p.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})$/);
    // ctx so the shipped-notification email can go out via waitUntil rather than
    // holding the dashboard's response open on a Resend round trip.
    if (ord && m === "PATCH") return adminUpdateOrder(env, ord[1], body, ctx);

    const refund = p.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/refund$/);
    if (refund && m === "POST") return adminRefundOrder(env, refund[1], body);

    if (p === "/api/admin/coupons" && m === "GET") return adminListCoupons(env);
    if (p === "/api/admin/coupons" && m === "POST") return adminCreateCoupon(env, body);

    // Matched BEFORE the bare :id form below, which is a prefix of this one.
    const redemptions = p.match(/^\/api\/admin\/coupons\/([0-9a-f-]{36})\/redemptions$/);
    if (redemptions && m === "GET") return adminCouponRedemptions(env, redemptions[1]);

    const coup = p.match(/^\/api\/admin\/coupons\/([0-9a-f-]{36})$/);
    if (coup && m === "PATCH") return adminUpdateCoupon(env, coup[1], body);
    if (coup && m === "DELETE") return adminDeleteCoupon(env, coup[1]);

    // ── quotes ──
    // Owner-only, like everything else in this block, and absent from
    // AGENT_ROUTES: these read customer names, emails and phone numbers, and
    // /reply mints a live payment link.
    if (p === "/api/admin/quotes" && m === "GET") return listQuotes(env, url);

    // Longest path first — /reply would otherwise be shadowed by the bare :id
    // form below, the same ordering trap the coupon routes above call out.
    const qreply = p.match(/^\/api\/admin\/quotes\/([0-9a-f-]{36})\/reply$/);
    if (qreply && m === "POST") return replyToQuote(env, qreply[1], body);

    const quo = p.match(/^\/api\/admin\/quotes\/([0-9a-f-]{36})$/);
    if (quo && m === "PATCH") return updateQuoteStatus(env, quo[1], body);

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

  // Record it before mailing. A request used to exist ONLY as two emails, so
  // losing the email lost the job — including the uploaded model, which was a
  // link inside that one message and nowhere else.
  //
  // Deliberately non-fatal: a D1 failure must not swallow a real customer's
  // request when the email would have gone out fine. The mail is still the thing
  // that reaches Aswin; this is the record beside it.
  const receipt = "QT-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  try {
    const t = now();
    await env.DB.prepare(
      `INSERT INTO quotes (id, receipt, status, cust_name, cust_email, cust_phone,
                           type, qty, description, ref_item, file_url, file_name,
                           created_at, updated_at)
       VALUES (?,?,'new',?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), receipt, q.name, q.email, q.phone,
           q.type, q.qty, q.desc, q.ref_item, q.file_url, q.file_name, t, t).run();
  } catch (e) {
    console.error("quote not recorded", receipt, e?.message || e);
  }

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
