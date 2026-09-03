// Search-engine plumbing: sitemap, robots, structured data.
//
// None of this changes what a visitor sees. It exists so Google can find out
// what the shop sells — which today it cannot, because the catalogue is fetched
// by JavaScript and there is no sitemap telling a crawler which URLs exist.

import { esc, rupees } from "./lib.js";

// The five policy pages plus the homepage. Static because they are, and because
// a crawler discovering /terms is worth almost nothing next to a product page —
// they are here for completeness, not traffic.
const STATIC_PAGES = [
  { path: "/", priority: "1.0", changefreq: "daily" },
  // The local landing page. Priority above the policy pages and just under the
  // homepage: it is the one static page written to be FOUND, targeting the
  // searches that bring a buyer in ("3d printing pondicherry") rather than the
  // ones a buyer only reads after arriving.
  { path: "/3d-printing-in-pondicherry", priority: "0.9", changefreq: "monthly" },
  { path: "/contact", priority: "0.5", changefreq: "monthly" },
  { path: "/shipping", priority: "0.3", changefreq: "yearly" },
  { path: "/refunds", priority: "0.3", changefreq: "yearly" },
  { path: "/terms", priority: "0.2", changefreq: "yearly" },
  { path: "/privacy", priority: "0.2", changefreq: "yearly" },
];

const baseUrl = (env) =>
  String(env.APP_BASE_URL || "https://3d-prints.aswincloud.com").replace(/\/$/, "");

// W3C datetime, which is what <lastmod> expects. A bad date makes Google ignore
// the field rather than reject the sitemap, so it fails quietly — hence the
// guard on a non-finite timestamp.
const isoDay = (ms) => {
  const t = Number(ms);
  return Number.isFinite(t) && t > 0
    ? new Date(t).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
};

// GET /sitemap.xml
//
// Generated per request rather than checked in: products are listed and hidden
// from the dashboard, so a static file would be wrong within a day and would
// keep pointing Google at pages that no longer exist.
export async function sitemap(env) {
  const base = baseUrl(env);

  // visible = 1 AND price_paise > 0.
  //
  // The price filter is not cosmetic. A quote-only product has no /p/<slug> page
  // — productPage() looks it up by slug and those rows are synthesised, or
  // priced at zero and deliberately not linkable — so listing one hands Google a
  // URL that 404s. Crawlers treat that as a quality signal against the whole
  // site, and it wastes the crawl budget that should go to real products.
  let products = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, updated_at FROM products
        WHERE visible = 1 AND price_paise > 0 AND slug IS NOT NULL AND slug != ''
        ORDER BY updated_at DESC`
    ).all();
    products = results || [];
  } catch (e) {
    // A sitemap missing its products is still a valid sitemap, and serving the
    // static pages beats returning a 500 that Google records as a fetch error.
    console.error("sitemap product query failed", e?.message || e);
  }

  const urls = [
    ...STATIC_PAGES.map((p) => ({
      loc: base + p.path,
      lastmod: isoDay(Date.now()),
      changefreq: p.changefreq,
      priority: p.priority,
    })),
    ...products.map((p) => ({
      loc: `${base}/p/${p.slug}`,
      lastmod: isoDay(p.updated_at),
      changefreq: "weekly",
      priority: "0.8",
    })),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) =>
      `  <url>\n` +
      `    <loc>${esc(u.loc)}</loc>\n` +
      `    <lastmod>${u.lastmod}</lastmod>\n` +
      `    <changefreq>${u.changefreq}</changefreq>\n` +
      `    <priority>${u.priority}</priority>\n` +
      `  </url>`
    ).join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // Crawlers re-fetch this often and it changes rarely. The edge absorbs
      // that; the origin sees one query per hour.
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, s-maxage=3600",
    },
  });
}

// GET /robots.txt
//
// Cloudflare serves an auto-generated one carrying AI content-signals and
// blocking the scraper bots (Amazonbot, Bytespider, CCBot, GPTBot…). Those rules
// are worth keeping — this EXTENDS them rather than replacing them, adding the
// two things they cannot know about: where the sitemap is, and that /shop is the
// admin dashboard.
export function robots(env) {
  const base = baseUrl(env);

  const body = [
    "# AswinPrints — 3d-prints.aswincloud.com",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    "# The owner dashboard. Owner-authenticated, so a crawler only ever gets a",
    "# sign-in page — but there is no reason to spend crawl budget finding that",
    "# out, and no reason for it to appear in a result.",
    "Disallow: /shop",
    "Disallow: /api/",
    "",
    "# AI training scrapers. Kept from Cloudflare's generated robots.txt, which",
    "# this file replaces — removing them would silently opt the shop's photos",
    "# back into datasets it had been excluded from.",
    ...["Amazonbot", "Applebot-Extended", "Bytespider", "CCBot", "ClaudeBot",
        "Google-Extended", "GPTBot", "meta-externalagent", "PerplexityBot"]
      .flatMap((bot) => [`User-agent: ${bot}`, "Disallow: /", ""]),
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, s-maxage=86400",
    },
  });
}

// ── structured data ───────────────────────────────────────────────
//
// JSON-LD is what lets a search result show a price and "in stock" rather than
// just a blue link.
//
// Checked before writing this: the shop's CSP has no 'unsafe-inline' in
// script-src, which blocks inline <script>. It does NOT block
// application/ld+json — that is data, not executable code. Verified by rendering
// a page with the real CSP and reading the parsed @type back, because
// silently-blocked structured data looks exactly like structured data that works.

const BUSINESS = (env) => {
  const base = baseUrl(env);
  return {
    "@type": "Store",
    "@id": base + "/#store",
    name: env.APP_NAME || "AswinPrints",
    url: base,
    email: env.OWNER_EMAIL || "aswin@aswincloud.com",
    // The address Razorpay required on /contact. Kept identical: two different
    // addresses for one business is worse than none.
    address: {
      "@type": "PostalAddress",
      streetAddress: "No.76, Venkata Nagar, Uruvaiyar, Villianur",
      addressLocality: "Pondicherry",
      postalCode: "605110",
      addressCountry: "IN",
    },
    areaServed: { "@type": "Country", name: "India" },
    priceRange: "₹₹",
  };
};

// Product schema for one item.
//
// Returns null for anything unpriced. An Offer with price 0 is not "free" to
// Google, it is invalid — and a Product with no offer is a Search Console
// warning. Quote-only items simply get no Product markup.
export function productJsonLd(env, product, { pageUrl, imageUrl }) {
  if (!(product?.price_paise > 0)) return null;
  const base = baseUrl(env);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || `${product.name}, 3D printed to order and shipped across India.`,
    image: [imageUrl],
    url: pageUrl,
    sku: product.slug,
    brand: { "@type": "Brand", name: env.APP_NAME || "AswinPrints" },
    offers: {
      "@type": "Offer",
      url: pageUrl,
      priceCurrency: "INR",
      // Rupees as a decimal string — schema.org wants the amount a customer
      // pays, and every price in this codebase is integer paise.
      price: (product.price_paise / 100).toFixed(2),
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: env.APP_NAME || "AswinPrints" },
      // Printed to order, so a link with a stale price should not be honoured
      // indefinitely. A month is long enough not to churn and short enough that
      // Google re-checks.
      priceValidUntil: isoDay(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    isRelatedTo: { "@id": base + "/#store" },
  };
}

// Homepage graph: the business itself plus the site, so a search for the brand
// can show a knowledge panel rather than a bare link.
export function homeJsonLd(env) {
  const base = baseUrl(env);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        ...BUSINESS(env),
        description: "Custom 3D printing in Pondicherry — figurines, home decor, "
          + "functional parts and prototypes, printed to order and shipped across India.",
      },
      {
        "@type": "WebSite",
        "@id": base + "/#website",
        url: base,
        name: env.APP_NAME || "AswinPrints",
        publisher: { "@id": base + "/#store" },
      },
    ],
  };
}

// ── server-rendered shop grid ─────────────────────────────────────
//
// The catalogue is fetched by JavaScript, so the HTML Google receives contains
// no product at all — "Kingfisher", "Dragon" and "Temple Gopuram" appear nowhere
// in the 42KB it downloads. Google does execute JavaScript, but it does so on a
// second pass that is slower and not guaranteed, and other crawlers (Bing,
// social previews, AI search) largely do not.
//
// So the same cards are rendered into #productGrid up front. main.js clears the
// grid before it renders (`productGrid.innerHTML = ''`), so these are REPLACED
// rather than duplicated — that is what makes this safe, and it is asserted in
// the browser test.
//
// The markup mirrors what main.js builds, so the page does not visibly reflow
// when the JS takes over. It deliberately omits the interactive parts (buy
// buttons, lightbox roles): those need event handlers that only exist after JS
// loads, and a button that does nothing is worse than no button.
// Same edge-resize as the client grid, and it must produce the SAME URL — this
// markup is replaced by main.js on load, so a mismatch would make the browser fetch
// every photo twice: once for the server card, once for the one that replaces it.
//
// `resize` is false under wrangler dev, where /cdn-cgi/ does not exist and every
// image would 404.
function cdnImage(path, width, resize) {
  const p = String(path || "").replace(/^\/+/, "");
  if (!resize || !p || /^https?:/i.test(p)) return "/" + p;
  return `/cdn-cgi/image/width=${width},format=auto,onerror=redirect/${p}`;
}

function cardHtml(env, p, resize) {
  const base = baseUrl(env);
  const priceLabel = p.price_paise > 0
    ? "₹" + Math.round(p.price_paise / 100).toLocaleString("en-IN")
    : "Price on request";

  // A real <a> to the product page. This is the single most valuable part for
  // search: it is how a crawler discovers all 59 product URLs from one page,
  // without needing the sitemap at all.
  const href = p.slug ? `${base}/p/${p.slug}` : null;
  const name = href
    ? `<a class="product-name" href="${esc(href)}">${esc(p.name)}</a>`
    : `<div class="product-name">${esc(p.name)}</div>`;

  return `<div class="product-card">` +
    `<div class="product-media">` +
      `<img src="${esc(cdnImage(p.image, 480, resize))}" alt="${esc(p.name)}" loading="lazy" decoding="async" width="400" height="400">` +
    `</div>` +
    `<div class="product-body">` +
      name +
      // No description here either, and it has to match main.js rather than being
      // decided on its own merits. This markup is what a visitor sees for the moment
      // before the script runs, and then the script rebuilds the same grid. If one
      // carries descriptions and the other does not, every card on the page shrinks
      // the instant JS loads — a layout shift on the busiest page on the site, which
      // Core Web Vitals measures and penalises.
      //
      // Little is given up for search. The valuable part of this grid is the 66 real
      // <a href="/p/..."> links, which is how a crawler reaches every product page
      // from one document — and the full description is on each of those pages, in
      // the copy and in its meta description.
      `<div class="product-foot"><div class="product-price">${esc(priceLabel)}</div></div>` +
    `</div>` +
  `</div>`;
}

// Inject the grid and the homepage's own head tags.
//
// Failure is silent by design: this is a crawler optimisation on the page every
// visitor loads, and a D1 hiccup must not cost a human the homepage. The caller
// wraps it, and any error returns the untouched response.
// The promo banner's one line, built server-side so the banner is in the first
// HTML rather than appearing after /api/products and pushing the whole page
// down (a measured 43–85px layout shift on every load while a promo ran).
// renderPromo() in main.js builds the identical string, and test/seo.mjs pins
// this one — if the two ever differ the banner would visibly re-flow.
export function promoBannerText(promo) {
  const off = promo.kind === "percent" ? promo.value + "% off" : rupees(promo.value) + " off";
  const caps = [];
  if (promo.kind === "percent" && promo.max_discount_paise) {
    caps.push("up to " + rupees(promo.max_discount_paise));
  }
  if (promo.min_order_paise) caps.push("on orders over " + rupees(promo.min_order_paise));
  if (promo.once_per_customer) caps.push("one use per customer");
  return off + (caps.length ? " — " + caps.join(", ") : "") + " with code " + promo.code;
}

// Widths the hero photos are offered at. Rendered sizes run from ~160px (a
// portrait card on a 360px phone) to ~520px (the landscape card on a tablet), so
// with DPR 2–3 the useful range is roughly 320–1200. The single 900px version
// was 2–3x more pixels than a phone could show for the two portraits.
const HERO_WIDTHS = [320, 480, 640, 900, 1200];

export function rewriteHome(env, response, products, url, promo = null) {
  const base = baseUrl(env);
  const canonical = base + "/";

  // /cdn-cgi/ is an edge feature; under wrangler dev it 404s, so the whole grid
  // would render broken while developing.
  const resize = !/^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const grid = products.map((p) => cardHtml(env, p, resize)).join("");

  // The three hero photos are real products. Keyed on image FILENAME rather than a
  // hardcoded slug: the photos were chosen because they compose well together, and
  // the catalogue is what knows their name, price and current slug. A slug renamed
  // in the dashboard would otherwise leave a dead link on the first screen.
  const byImage = new Map(
    products.map((p) => [String(p.image || "").replace(/^.*\//, ""), p]),
  );

  // Counts hero photos as they stream past, so only the first is eager.
  let heroImg = 0;

  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(
          `<link rel="canonical" href="${esc(canonical)}" />` +
          jsonLdScript(homeJsonLd(env)),
          { html: true },
        );
      },
    })
    // setInnerContent replaces the "Loading…" placeholder rather than appending
    // to it, so a crawler never sees both.
    .on("#productGrid", {
      element(el) { el.setInnerContent(grid, { html: true }); },
    })
    // The promo banner, in the HTML rather than filled in by JS after
    // /api/products lands. main.js still owns dismissal and the "already
    // redeemed" case; it reads data-promo-code to hide a dismissed banner before
    // first paint, and redraws the same text once the API answers.
    .on("#promoBanner", {
      element(el) {
        if (!promo || !promo.code) return;
        el.removeAttribute("hidden");
        el.setAttribute("data-promo-code", promo.code);
      },
    })
    .on("#promoText", {
      element(el) {
        if (!promo || !promo.code) return;
        el.setInnerContent(promoBannerText(promo));
      },
    })
    // Point each hero photo at its product page. Left as the #shop anchor when the
    // product is not in the visible set — a hidden or deleted piece degrades to a
    // decorative photo rather than a 302 from the first thing on the page.
    .on("[data-hero]", {
      element(el) {
        const p = byImage.get(el.getAttribute("data-hero"));
        if (p && p.slug) el.setAttribute("href", `/p/${p.slug}`);
      },
    })
    // The hero photos were the one image surface that never went through the edge
    // resizer. The grid has since it was built; these shipped as full 1200x1600
    // originals — 342KB of JPEG, eagerly, ahead of everything else on the page,
    // and two of the three are off-screen until the strip is swiped.
    //
    // Rewritten here rather than in the markup because /cdn-cgi/ is an edge
    // feature that 404s under `wrangler dev` — the same reason cardHtml takes a
    // `resize` flag rather than hardcoding the path.
    .on("[data-hero] img", {
      element(el) {
        const src = String(el.getAttribute("src") || "").replace(/^\/+/, "");
        if (resize && src && !/^https?:/i.test(src)) {
          const at = (w) => `/cdn-cgi/image/width=${w},format=auto,onerror=redirect/${src}`;
          el.setAttribute("src", at(640));
          // `sizes` is in the markup per card, since the landscape card is wider.
          el.setAttribute("srcset", HERO_WIDTHS.map((w) => `${at(w)} ${w}w`).join(", "));
        }
        heroImg += 1;
        if (heroImg === 1) {
          // The largest thing on the first screen, so almost certainly the LCP
          // element. Worth telling the browser before it guesses.
          el.setAttribute("fetchpriority", "high");
        } else {
          // Off-screen in the strip until swiped. Eager here spends a visitor's
          // data on pictures they may never scroll to.
          el.setAttribute("loading", "lazy");
        }
      },
    })
    // …and give it a name and a price. Server-rendered, so it is in the HTML a
    // crawler reads and there is no moment where the photo is on screen without it.
    .on("[data-hero-meta]", {
      element(el) {
        const p = byImage.get(el.getAttribute("data-hero-meta"));
        if (!p || !(p.price_paise > 0)) return;
        el.setInnerContent(
          `<span class="hero-shot-name">${esc(p.name)}</span>` +
          `<span class="hero-shot-price">${esc(rupees(p.price_paise))}</span>`,
          { html: true },
        );
      },
    })
    .transform(response);
}

// The local landing page's structured data.
//
// Two schemas, because they answer different searches:
//   - LocalBusiness, so "3d printing near me" and map-style queries can match a
//     business with a real address in Pondicherry.
//   - FAQPage, which is what can put the turnaround and shipping answers
//     directly into a search result.
//
// Every answer here repeats what the page body says. Structured data that
// disagrees with the visible page is a Search Console violation, not a shortcut.
export function localPageJsonLd(env) {
  const base = baseUrl(env);
  const url = base + "/3d-printing-in-pondicherry";

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        ...BUSINESS(env),
        "@type": "LocalBusiness",
        "@id": url + "#business",
        description: "Custom 3D printing in Pondicherry — figurines, home decor, "
          + "functional parts and prototypes, printed on a Bambu Lab A1 and shipped "
          + "across India.",
        telephone: "+916380157944",
      },
      {
        "@type": "FAQPage",
        "@id": url + "#faq",
        mainEntity: [
          {
            "@type": "Question",
            name: "How long does a 3D print take?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Items already listed in the shop take 3–5 days, plus delivery. "
                + "Custom work depends on size and complexity, and you get a specific "
                + "timeline with your quote.",
            },
          },
          {
            "@type": "Question",
            name: "Do you deliver outside Pondicherry?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Yes — anywhere in India. Shipping is a flat ₹99 and free on "
                + "orders over ₹2,000, with a tracking ID emailed when the parcel "
                + "is dispatched.",
            },
          },
          {
            "@type": "Question",
            name: "Can you print something custom?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Yes. Send an idea, a photo or an STL file and you get a free "
                + "quote covering whether it is printable and what it will cost.",
            },
          },
          {
            "@type": "Question",
            name: "Do you take bulk or corporate orders?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Yes — wedding and event favours, corporate gifts, college "
                + "project models and promotional pieces. Batch pricing differs, so "
                + "message with the quantity and deadline before ordering.",
            },
          },
        ],
      },
    ],
  };
}

// Serialised for injection into <head>.
//
// `</script>` inside a JSON string would close the block early and put the rest
// of the JSON into the document as text — the one way an inline ld+json block
// can break a page. Escaped rather than trusted, since product names and
// descriptions are owner-editable free text.
export const jsonLdScript = (data) =>
  `<script type="application/ld+json">${
    JSON.stringify(data).replace(/</g, "\\u003c")
  }</script>`;
