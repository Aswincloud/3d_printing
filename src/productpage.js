// Shareable per-product links: GET /p/<slug>
//
// Serves the normal single-page shop with the Open Graph tags rewritten for one
// product, so a link pasted into WhatsApp, Instagram or Slack previews that
// product's photo, name and price instead of a generic site card.
//
// Why server-side: link crawlers (WhatsApp, Facebook, Twitter, Slack, iMessage)
// fetch the HTML and read the meta tags. None of them execute JavaScript, so
// setting og:* from main.js would work for nothing — the preview is built from
// whatever the first HTML response contains. HTMLRewriter lets us patch the tags
// on the way out without maintaining a second HTML file that would drift from
// index.html.
//
// The URL is /p/<slug> rather than ?product=<slug> because a bare path survives
// copy-paste and truncation better, and slugs are already unique and readable
// (articulated-dino-skeleton, ganesha-veena).

import { esc } from "./lib.js";

// Slugs are lowercase words and dashes — see slugify() in admin.js. Anything else
// cannot be a real slug, so it is rejected before the query rather than becoming
// a wasted D1 round trip. Also bounds what can reach the meta tags.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 80;

export function isProductPath(pathname) {
  return pathname.startsWith("/p/");
}

export function slugFromPath(pathname) {
  const raw = decodeURIComponent(pathname.slice(3)).replace(/\/+$/, "");
  return raw.length && raw.length <= MAX_SLUG && SLUG_RE.test(raw) ? raw : null;
}

// Absolute URL, because og:image and og:url are meaningless as relative paths —
// crawlers do not resolve them against the page. index.html shipped a relative
// og:image for this reason and previewed no image at all.
function absolute(env, path, url) {
  const base = (env.APP_BASE_URL || url.origin).replace(/\/+$/, "");
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return base + "/" + String(path).replace(/^\/+/, "");
}

const rupees = (paise) =>
  "₹" + Math.round(paise / 100).toLocaleString("en-IN");

// Trimmed to a length link previews actually show; most clients cut around 150–200
// characters, and a sentence cut mid-word reads as broken.
function clampDescription(text, limit = 180) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "") + "…";
}

// Only `visible = 1`. A hidden product must not become shareable through this
// route — that would reintroduce, via a different door, exactly the exposure the
// visible flag exists to prevent.
async function loadProduct(env, slug) {
  return env.DB.prepare(
    `SELECT slug, name, description, price_paise, image
       FROM products WHERE slug = ? AND visible = 1`
  ).bind(slug).first();
}

// Rewrites the <head> of index.html for one product.
//
// setAttribute on existing tags where index.html already has them, and append to
// <head> for the ones it does not. Doing it this way (rather than templating a
// separate file) means index.html stays the single source of the page: a change to
// the markup, the CSS link or the icons is picked up here for free.
function rewriteHead(response, { product, pageUrl, imageUrl, title, description }) {
  const setContent = { element(el) { el.setAttribute("content", description); } };

  return new HTMLRewriter()
    // FIRST, before anything else in <head>: index.html references its assets
    // relatively ("assets/css/style.css", "assets/js/main.js", three hero images).
    // Served at /p/<slug> the browser resolves those against /p/, requests
    // /p/assets/… and gets 404s — no CSS, no JS, zero product cards. The page was
    // completely blank-shell broken for exactly the visitors arriving from a
    // shared link, which is the whole point of the feature.
    //
    // A <base href="/"> fixes all of them at once and keeps index.html as the
    // single copy of the page. Rewriting each path instead would mean this module
    // has to know every asset reference in the markup and stay in step with it.
    // Prepended to <head> because <base> only affects URLs that come after it.
    .on("head", {
      element(el) { el.prepend(`<base href="/" />`, { html: true }); },
    })
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', setContent)
    .on('meta[property="og:description"]', setContent)
    .on('meta[property="og:title"]', {
      element(el) { el.setAttribute("content", title); },
    })
    .on('meta[property="og:image"]', {
      element(el) { el.setAttribute("content", imageUrl); },
    })
    // index.html carries homepage og:url and og:type. They must be REWRITTEN, not
    // appended to: two conflicting og:url values in one document is undefined
    // behaviour across crawlers, and the first-wins ones would re-crawl a shared
    // product link as the homepage and preview the wrong thing. Caught by seeing
    // both pairs in the output.
    .on('meta[property="og:url"]', {
      element(el) { el.setAttribute("content", pageUrl); },
    })
    .on('meta[property="og:type"]', {
      element(el) { el.setAttribute("content", "product"); },
    })
    .on("head", {
      element(el) {
        el.append(
          `<meta property="og:site_name" content="AswinPrints" />` +
          // Twitter/X reads its own namespace and ignores og:* for the card type.
          // twitter:card is already in index.html and is the same value for both,
          // so it is not repeated here.
          `<meta name="twitter:title" content="${esc(title)}" />` +
          `<meta name="twitter:description" content="${esc(description)}" />` +
          `<meta name="twitter:image" content="${esc(imageUrl)}" />` +
          // Price, which WhatsApp ignores but Facebook and some others surface.
          `<meta property="product:price:amount" content="${(product.price_paise / 100).toFixed(2)}" />` +
          `<meta property="product:price:currency" content="INR" />` +
          `<link rel="canonical" href="${esc(pageUrl)}" />` +
          // Consumed by main.js on load to scroll to and open this product. Read
          // from the DOM rather than the URL so the client does not have to parse
          // the path a second time and agree with the server about what is valid.
          `<meta name="ap:product" content="${esc(product.slug)}" />`,
          { html: true },
        );
      },
    })
    .transform(response);
}

// GET /p/<slug>
//
// Returns the shop page with product-specific meta tags, or redirects to the shop
// for an unknown/hidden slug. A redirect rather than a 404 page: the product may
// have been delisted after someone shared it, and dropping a visitor on the
// catalogue is more useful than an error. 302, not 301 — a delisted product can
// come back, and a permanent redirect would be cached by browsers indefinitely.
export async function productPage(request, env, url) {
  const slug = slugFromPath(url.pathname);
  if (!slug) return Response.redirect(absolute(env, "/#shop", url), 302);

  let product = null;
  try {
    product = await loadProduct(env, slug);
  } catch (e) {
    // A D1 failure should not take the page down: fall through to the shop, which
    // fetches the catalogue client-side and can still work.
    console.error("product page lookup failed", slug, e?.message || e);
    return Response.redirect(absolute(env, "/#shop", url), 302);
  }
  if (!product) return Response.redirect(absolute(env, "/#shop", url), 302);

  // Fetch index.html through the assets binding so there is one copy of the page.
  const assetUrl = new URL(url);
  assetUrl.pathname = "/index.html";
  assetUrl.search = "";
  const page = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
  if (!page.ok) return page;

  const title = `${product.name} — ${rupees(product.price_paise)} · AswinPrints`;
  const description = clampDescription(
    product.description || `${product.name}, 3D printed to order and shipped across India.`
  );

  const rewritten = rewriteHead(page, {
    product,
    pageUrl: absolute(env, "/p/" + product.slug, url),
    imageUrl: absolute(env, product.image, url),
    title,
    description,
  });

  return new Response(rewritten.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Short cache: the price and name come from D1 and the owner edits them in
      // the dashboard, so a long TTL would serve a stale price in a link preview.
      // s-maxage lets the edge absorb a burst of crawler hits on a viral link.
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, s-maxage=300",
    },
  });
}
