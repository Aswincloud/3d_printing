// Offline tests for the search-engine surface.
//
// Run: node test/seo.mjs
//
// Two failures here are expensive and silent:
//
//   1. A sitemap URL that 404s. Google treats it as a quality signal against the
//      whole site and wastes crawl budget that should reach real products.
//   2. A JSON-LD price that disagrees with the page. That is a Search Console
//      error, and in the worst case a customer arriving from a result expecting
//      a price the shop will not honour.
//
// Neither shows up by looking at the site.

import { sitemap, robots, productJsonLd, homeJsonLd, jsonLdScript, localPageJsonLd } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = {
  APP_NAME: "AswinPrints",
  APP_BASE_URL: "https://3d-prints.aswincloud.com",
  OWNER_EMAIL: "aswin@aswincloud.com",
};

// Products spanning every case that decides whether a URL belongs in a sitemap.
const PRODUCTS = [
  { slug: "dragon", name: "Dragon", price_paise: 129900, visible: 1, updated_at: 1785000000000 },
  { slug: "kingfisher", name: "Kingfisher", price_paise: 34900, visible: 1, updated_at: 1785900000000 },
  { slug: "hidden-thing", name: "Hidden", price_paise: 54900, visible: 0, updated_at: 1785000000000 },
  { slug: "quote-only", name: "Unpriced", price_paise: 0, visible: 1, updated_at: 1785000000000 },
  { slug: "", name: "No Slug", price_paise: 9900, visible: 1, updated_at: 1785000000000 },
];

// Honours the real WHERE clause by reading it off the SQL, so removing a filter
// changes what the fake returns and the tests fail. A fake that always filtered
// would make these pass regardless of the query.
function envWith(rows = PRODUCTS) {
  return {
    ...ENV,
    DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, " ").trim();
        return {
          bind() { return this; },
          async all() {
            if (!s.startsWith("SELECT slug, updated_at FROM products")) {
              throw new Error("unhandled SQL in seo fake: " + s.slice(0, 70));
            }
            const wantVisible = /visible = 1/.test(s);
            const wantPriced = /price_paise > 0/.test(s);
            const wantSlug = /slug != ''/.test(s);
            return {
              results: rows.filter((r) =>
                (!wantVisible || r.visible === 1)
                && (!wantPriced || r.price_paise > 0)
                && (!wantSlug || (r.slug && r.slug !== ""))),
            };
          },
        };
      },
    },
  };
}

const text = async (res) => await res.text();

// ── sitemap ───────────────────────────────────────────────────────
section("sitemap.xml");
{
  const res = await sitemap(envWith());
  const xml = await text(res);

  ok("served as XML", /application\/xml/.test(res.headers.get("content-type") || ""),
     res.headers.get("content-type"));
  ok("has the XML declaration", xml.startsWith('<?xml version="1.0"'));
  ok("has the sitemap namespace", xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  ok("edge-cached", /s-maxage/.test(res.headers.get("cdn-cache-control") || ""));

  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  ok("every URL is absolute https", locs.every((l) => l.startsWith("https://")),
     locs.find((l) => !l.startsWith("https://")) || "");
  ok("no duplicate URLs", new Set(locs).size === locs.length);
  ok("the homepage is listed", locs.includes("https://3d-prints.aswincloud.com/"));
  ok("policy pages are listed", locs.includes("https://3d-prints.aswincloud.com/contact"));

  // The local landing page. In the sitemap, so a 404 here is a dead URL handed
  // straight to Google — and it 404'd on production once already, because the
  // path was missing from run_worker_first.
  ok("the Pondicherry landing page is listed",
     locs.includes("https://3d-prints.aswincloud.com/3d-printing-in-pondicherry"));
  ok("it outranks the policy pages", (() => {
    const prio = xml.match(/<loc>[^<]*3d-printing-in-pondicherry<\/loc>[\s\S]*?<priority>([\d.]+)<\/priority>/);
    return prio && Number(prio[1]) >= 0.9;
  })(), "it is the page written to be found; policies are read after arriving");

  // ── THE assertions that matter ──
  //
  // Each of these, if wrong, puts a URL in the sitemap that returns a 404 or a
  // redirect. Google counts those against the site.
  ok("a PRICED, VISIBLE product is listed",
     locs.includes("https://3d-prints.aswincloud.com/p/dragon"));
  ok("a HIDDEN product is NOT listed",
     !locs.some((l) => l.includes("hidden-thing")),
     "productPage() redirects a hidden slug — Google would record a redirect chain");
  ok("a QUOTE-ONLY product is NOT listed",
     !locs.some((l) => l.includes("quote-only")),
     "an unpriced item has no product page; this would be a 404 in the sitemap");
  ok("a product with no slug is NOT listed",
     !locs.some((l) => l.endsWith("/p/")),
     "would produce a bare /p/ URL");

  ok("exactly the two linkable products", locs.filter((l) => l.includes("/p/")).length === 2,
     String(locs.filter((l) => l.includes("/p/")).length));

  // lastmod must be a date Google will accept, or it silently ignores the field.
  const mods = [...xml.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map((m) => m[1]);
  ok("every lastmod is a valid date", mods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
     mods.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)) || "");
  ok("product lastmod comes from the row",
     mods.includes(new Date(1785900000000).toISOString().slice(0, 10)));
}
{
  // A D1 failure must still produce a valid sitemap with the static pages, not a
  // 500 that Google records as a fetch error against the site.
  const env = {
    ...ENV,
    DB: { prepare: () => ({ bind() { return this; }, async all() { throw new Error("D1 down"); } }) },
  };
  const xml = await text(await sitemap(env));
  ok("survives a D1 failure", xml.includes("<urlset"));
  ok("and still lists the static pages", xml.includes("https://3d-prints.aswincloud.com/"));
  ok("with no product URLs", !xml.includes("/p/"));
}
{
  // XML-unsafe characters in a slug would break the document for every crawler.
  const env = envWith([
    { slug: "a&b", name: "Amp", price_paise: 100, visible: 1, updated_at: 1785000000000 },
  ]);
  const xml = await text(await sitemap(env));
  ok("ampersand in a slug is escaped", xml.includes("a&amp;b"), "raw & breaks the XML");
  ok("no raw ampersand survives", !/&(?!amp;|lt;|gt;|quot;|#)/.test(xml));
}

// ── robots ────────────────────────────────────────────────────────
section("robots.txt");
{
  const res = robots(ENV);
  const body = await text(res);

  ok("served as plain text", /text\/plain/.test(res.headers.get("content-type") || ""));
  ok("allows everyone by default", /User-agent: \*\nAllow: \//.test(body));
  ok("points at the sitemap",
     body.includes("Sitemap: https://3d-prints.aswincloud.com/sitemap.xml"));
  ok("keeps the dashboard out", /Disallow: \/shop/.test(body));
  ok("keeps the API out", /Disallow: \/api\//.test(body));

  // Cloudflare's generated robots.txt blocks these; replacing it without them
  // would silently opt the shop's photos back into AI training datasets.
  for (const bot of ["Amazonbot", "Bytespider", "CCBot", "GPTBot", "ClaudeBot"]) {
    ok(`still blocks ${bot}`, new RegExp(`User-agent: ${bot}\\nDisallow: /`).test(body));
  }
  ok("does not accidentally block everything",
     !/User-agent: \*\nDisallow: \/\s*$/m.test(body),
     "a Disallow: / under the wildcard would deindex the entire site");
}

// ── structured data ───────────────────────────────────────────────
section("Product JSON-LD");
{
  const p = { slug: "dragon", name: "Dragon", description: "A dragon.", price_paise: 129900 };
  const ld = productJsonLd(ENV, p, {
    pageUrl: "https://3d-prints.aswincloud.com/p/dragon",
    imageUrl: "https://3d-prints.aswincloud.com/assets/images/dragon.jpg",
  });

  ok("is a Product", ld["@type"] === "Product");
  ok("has the schema.org context", ld["@context"] === "https://schema.org");
  ok("carries the name", ld.name === "Dragon");
  ok("image is absolute", ld.image[0].startsWith("https://"));

  // THE number. A JSON-LD price that disagrees with the page is a Search Console
  // error, and a customer arriving expecting a price the shop will not honour.
  ok("price is rupees, not paise", ld.offers.price === "1299.00", ld.offers.price);
  ok("currency is INR", ld.offers.priceCurrency === "INR");
  ok("marked in stock", /InStock/.test(ld.offers.availability));
  ok("has a priceValidUntil", /^\d{4}-\d{2}-\d{2}$/.test(ld.offers.priceValidUntil));
}
{
  // Prices that round badly are where a naive conversion shows.
  for (const [paise, expect] of [[99900, "999.00"], [1, "0.01"], [34950, "349.50"], [1200000, "12000.00"]]) {
    const ld = productJsonLd(ENV, { slug: "x", name: "X", price_paise: paise },
      { pageUrl: "https://x/p/x", imageUrl: "https://x/i.jpg" });
    ok(`${paise} paise → ${expect}`, ld.offers.price === expect, ld.offers.price);
  }
}
{
  // An Offer with price 0 is invalid to Google, not free. Quote-only items get
  // no Product markup rather than broken Product markup.
  for (const paise of [0, null, undefined, -100]) {
    const ld = productJsonLd(ENV, { slug: "x", name: "X", price_paise: paise },
      { pageUrl: "https://x/p/x", imageUrl: "https://x/i.jpg" });
    ok(`price ${JSON.stringify(paise)} → no Product markup at all`, ld === null);
  }
}

// ── the local landing page's structured data ──────────────────────
section("local landing page JSON-LD");
{
  const ld = localPageJsonLd(ENV);
  const json = JSON.stringify(ld);
  const graph = ld["@graph"];

  ok("is a graph", Array.isArray(graph));
  ok("declares a LocalBusiness", graph.some((g) => g["@type"] === "LocalBusiness"));
  ok("declares an FAQPage", graph.some((g) => g["@type"] === "FAQPage"));

  const biz = graph.find((g) => g["@type"] === "LocalBusiness");
  // Must match /contact exactly. Two addresses for one business is worse than
  // none — Google treats a mismatch as a signal the data is unreliable.
  ok("street address matches /contact", biz.address.streetAddress.includes("Venkata Nagar"));
  ok("postal code matches", biz.address.postalCode === "605110");
  ok("phone is E.164", /^\+91\d{10}$/.test(biz.telephone || ""), biz.telephone);

  const faq = graph.find((g) => g["@type"] === "FAQPage");
  ok("has four questions", faq.mainEntity.length === 4, String(faq.mainEntity.length));
  ok("every question has an answer",
     faq.mainEntity.every((q) => q.acceptedAnswer?.text?.length > 20));

  // The answers must repeat what the page says. Structured data that contradicts
  // the visible page is a Search Console violation, not a shortcut.
  const answers = faq.mainEntity.map((q) => q.acceptedAnswer.text).join(" ");
  ok("turnaround answer matches the page", /3.5 days/.test(answers), answers.slice(0, 60));
  ok("shipping answer matches the page", /₹99/.test(answers) && /₹2,000/.test(answers));
  ok("bulk orders are covered", /bulk|corporate|favours/i.test(json));
}

section("homepage JSON-LD");
{
  const ld = homeJsonLd(ENV);
  const json = JSON.stringify(ld);
  ok("is a graph", Array.isArray(ld["@graph"]));
  ok("declares a Store", json.includes('"Store"'));
  ok("carries the registered address", json.includes("Venkata Nagar"));
  ok("carries the PIN", json.includes("605110"));
  ok("country is IN", json.includes('"addressCountry":"IN"'));
  ok("declares the website", json.includes('"WebSite"'));
}

section("script serialisation");
{
  // `</script>` inside a product name or description would close the block early
  // and dump the rest of the JSON into the page as visible text. Product copy is
  // owner-editable free text, so this is reachable.
  const evil = jsonLdScript({ name: "</script><img src=x onerror=alert(1)>" });
  ok("no raw </script> escapes the block", !evil.includes("</script><img"),
     evil.slice(0, 90));
  ok("< is escaped in the JSON", evil.includes("\\u003c"));
  ok("the block still closes properly", evil.trim().endsWith("</script>"));
  ok("and it is still valid JSON", (() => {
    const inner = evil.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    try { JSON.parse(inner); return true; } catch { return false; }
  })());
}

console.log(`\n  seo: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
