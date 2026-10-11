// GET /feed/google.xml — the Google Merchant Center product feed.
//
// Merchant Center fetches this on a schedule (set up once in its dashboard as a
// "scheduled fetch"), so the catalogue in Google Shopping follows the shop on
// its own: list or hide a product in the dashboard and Google catches up on the
// next fetch. Same filter as the sitemap — visible and priced — because every
// item's link must be a live /p/<slug> page, or Merchant Center disapproves it.

import { esc } from "./lib.js";

const baseUrl = (env) =>
  String(env.APP_BASE_URL || "https://3d-prints.aswincloud.com").replace(/\/$/, "");

// Kept out of Google Shopping, though they stay on the site. Merchant Center
// suspends whole accounts — not just the item — for counterfeit/IP and weapons
// policy, so one Spider-Man figurine can take the other ninety products down
// with it. Same reasoning, and nearly the same list, as the Amazon catalogue.
//
// Two layers, because a slug list only knows today's products: the keyword
// pattern catches the next licensed character added from the dashboard without
// anyone remembering to update this file.
const EXCLUDED_SLUGS = new Set([
  "gta-comic-panel", "ps-trophy", "gta6-stand", "toothless-collection",
  "full-collection", "little-prince-scene", "carebear-figurine",
  "desert-eagle-replica", "katana-display-sword",
  // The national emblem (Ashoka Chakra) — State Emblem Act, as on Amazon.
  "india-tricolor-map",
]);
const EXCLUDED_WORDS = /spider-?man|marvel|avenger|iron.?man|hulk|venom|captain.?america|batman|superman|joker|cyclops|x-?men|pok[eé]mon|pikachu|charizard|goku|dragon.?ball|naruto|luffy|one.?piece|disney|tinker.?bell|care.?bear|gta|playstation|\bps[45]?\b|sony|nintendo|mario|star.?wars|harry.?potter|replica|gun|pistol|rifle|sword|katana|knife/i;

export const inFeed = (p) =>
  !EXCLUDED_SLUGS.has(p.slug) && !EXCLUDED_WORDS.test(`${p.slug} ${p.name}`);

// Google's taxonomy by name; Merchant Center accepts the text path as well as
// the numeric id. "functional" is left for Google to infer — a pen holder and a
// wall shelf have nothing in common but the printer.
const CATEGORY = {
  decor: "Home & Garden > Decor",
  figurine: "Home & Garden > Decor > Figurines",
  set: "Home & Garden > Decor > Figurines",
};

const abs = (base, path) =>
  /^https?:\/\//i.test(path) ? path : `${base}/${String(path).replace(/^\/+/, "")}`;

// 5,000 is Google's limit for g:description.
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function googleFeed(env) {
  const base = baseUrl(env);
  const brand = env.APP_NAME || "AswinPrints";

  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, name, description, price_paise, image, images, category
         FROM products
        WHERE visible = 1 AND price_paise > 0 AND slug IS NOT NULL AND slug != ''
        ORDER BY sort, name`
    ).all();
    rows = results || [];
  } catch (e) {
    // Unlike the sitemap, a half-empty feed is worse than an error: Merchant
    // Center reads a missing item as "delete it". A 500 makes it keep the last
    // good fetch instead.
    console.error("feed product query failed", e?.message || e);
    throw e;
  }

  const items = rows.filter(inFeed).map((p) => {
    const link = `${base}/p/${p.slug}`;
    const extra = String(p.images || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const desc = p.description || `${p.name}, 3D printed to order and shipped across India.`;
    return [
      `<item>`,
      `<g:id>${esc(p.slug)}</g:id>`,
      `<g:title>${esc(clip(p.name, 150))}</g:title>`,
      `<g:description>${esc(clip(desc, 5000))}</g:description>`,
      `<g:link>${esc(link)}</g:link>`,
      `<g:image_link>${esc(abs(base, p.image))}</g:image_link>`,
      ...extra.map((i) => `<g:additional_image_link>${esc(abs(base, i))}</g:additional_image_link>`),
      // In stock rather than "preorder": printed to order, but it ships within
      // the handling time Merchant Center is told about, which is what Google
      // means by available.
      `<g:availability>in_stock</g:availability>`,
      // The selling price only. compare_at is not sent as a sale: Google
      // requires the higher price to have actually been charged, and checks.
      `<g:price>${(p.price_paise / 100).toFixed(2)} INR</g:price>`,
      `<g:condition>new</g:condition>`,
      `<g:brand>${esc(brand)}</g:brand>`,
      // Own designs, printed in-house: there is no GTIN or MPN to give.
      `<g:identifier_exists>no</g:identifier_exists>`,
      CATEGORY[p.category] ? `<g:google_product_category>${esc(CATEGORY[p.category])}</g:google_product_category>` : "",
      p.category ? `<g:product_type>${esc(p.category)}</g:product_type>` : "",
      `</item>`,
    ].filter(Boolean).join("");
  });

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n` +
    `<title>${esc(brand)}</title>\n<link>${esc(base)}</link>\n` +
    `<description>3D printed décor, idols and gifts</description>\n` +
    items.join("\n") +
    `\n</channel>\n</rss>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, s-maxage=3600",
    },
  });
}
