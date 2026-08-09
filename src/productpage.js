// The product page: GET /p/<slug>
//
// Loads one product, gathers what the page needs around it (related items), and
// hands off to src/pdp.js to render. This module owns the ROUTE — slug parsing,
// the lookup, the not-found behaviour, the meta tags and the cache headers —
// while pdp.js owns the markup.
//
// It used to serve index.html with rewritten Open Graph tags, which previewed
// correctly in WhatsApp and Slack but gave a visitor the entire homepage with a
// lightbox over it. Everything is server-rendered now, so a crawler and a person
// see the same page.
//
// The URL is /p/<slug> rather than ?product=<slug> because a bare path survives
// copy-paste and truncation better, and slugs are already unique and readable
// (articulated-dino-skeleton, ganesha-veena).

import { esc } from "./lib.js";
import { productJsonLd, jsonLdScript } from "./seo.js";
import { renderProductPage, breadcrumbJsonLd } from "./pdp.js";

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
  // `category` drives the breadcrumb trail and the related-products query;
  // `images` is the gallery. Both were unnecessary when this route only rewrote
  // meta tags on the homepage, and both are required now that it renders a page.
  return env.DB.prepare(
    `SELECT slug, name, description, price_paise, image, images, category
       FROM products WHERE slug = ? AND visible = 1`
  ).bind(slug).first();
}

// NOTE: rewriteHead() lived here until /p/<slug> became a real page.
//
// It fetched index.html and patched its <head> so a shared link previewed the
// right product. That worked for link crawlers, but the document a visitor got
// was still the whole homepage — grid, hero, quote form — with a lightbox opened
// over it. src/pdp.js renders an actual product page instead, so the rewriter and
// its <base href="/"> workaround are gone rather than left as unreachable code.

// GET /p/<slug>
//
// Returns a rendered product page, or redirects to the shop for an
// unknown/hidden slug. A redirect rather than a 404 page: the product may
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

  const title = product.price_paise > 0
    ? `${product.name} — ${rupees(product.price_paise)} · AswinPrints`
    : `${product.name} · AswinPrints`;
  const description = clampDescription(
    product.description || `${product.name}, 3D printed to order and shipped across India.`
  );

  const pageUrl = absolute(env, "/p/" + product.slug, url);
  const imageUrl = absolute(env, product.image, url);
  const ld = productJsonLd(env, product, { pageUrl, imageUrl });

  // Other products in the same category, for the "More in…" row.
  //
  // Excludes this product and anything hidden. Wrapped: a related-products query
  // failing must not take down the page someone was actually trying to see — the
  // row simply does not render.
  let related = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, name, price_paise, image FROM products
        WHERE visible = 1 AND slug != ? AND slug IS NOT NULL AND slug != ''
          AND category = ?
        ORDER BY sort ASC LIMIT 4`
    ).bind(product.slug, product.category || "").all();
    related = results || [];
  } catch (e) {
    console.error("related products failed", product.slug, e?.message || e);
  }

  // A product with no category, or the only one in its category, would get an
  // empty row. Fall back to anything else visible rather than showing a heading
  // with nothing under it.
  if (!related.length) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT slug, name, price_paise, image FROM products
          WHERE visible = 1 AND price_paise > 0 AND slug != ?
            AND slug IS NOT NULL AND slug != ''
          ORDER BY sort ASC LIMIT 4`
      ).bind(product.slug).all();
      related = results || [];
    } catch { /* leave it empty */ }
  }

  const head =
    `<title>${esc(title)}</title>` +
    `<meta name="description" content="${esc(description)}" />` +
    `<link rel="canonical" href="${esc(pageUrl)}" />` +
    `<meta property="og:type" content="product" />` +
    `<meta property="og:site_name" content="AswinPrints" />` +
    `<meta property="og:title" content="${esc(title)}" />` +
    `<meta property="og:description" content="${esc(description)}" />` +
    `<meta property="og:image" content="${esc(imageUrl)}" />` +
    `<meta property="og:url" content="${esc(pageUrl)}" />` +
    `<meta name="twitter:card" content="summary_large_image" />` +
    `<meta name="twitter:title" content="${esc(title)}" />` +
    `<meta name="twitter:description" content="${esc(description)}" />` +
    `<meta name="twitter:image" content="${esc(imageUrl)}" />` +
    (product.price_paise > 0
      ? `<meta property="product:price:amount" content="${(product.price_paise / 100).toFixed(2)}" />`
        + `<meta property="product:price:currency" content="INR" />`
      : "") +
    // Empty string rather than undefined: an unpriced product gets no Product
    // markup at all, and appending "undefined" into <head> would be worse than
    // appending nothing.
    (ld ? jsonLdScript(ld) : "") +
    jsonLdScript(breadcrumbJsonLd(env, product));

  const html = renderProductPage(env, { product, related, headExtra: head });

  return new Response(html, {
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
