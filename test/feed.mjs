// Offline tests for the Google Merchant Center feed.
//
// Run: node test/feed.mjs
//
// The failure that matters is an excluded product leaking in: Merchant Center
// suspends the whole account for IP or weapons policy, not just the item.

import { googleFeed, inFeed } from "../src/feed.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const PRODUCTS = [
  { slug: "ganesha-veena", name: "Ganesha with Veena", description: "Idol & <gift>", price_paise: 49900, image: "assets/images/g.jpg?v=1", images: "assets/images/g2.jpg", category: "figurine", visible: 1 },
  { slug: "golden-vase", name: "Golden Vase", description: "", price_paise: 29900, image: "assets/images/v.jpg", images: "", category: "decor", visible: 1 },
  { slug: "hidden-thing", name: "Hidden", price_paise: 54900, image: "x.jpg", visible: 0 },
  { slug: "quote-only", name: "Unpriced", price_paise: 0, image: "x.jpg", visible: 1 },
  { slug: "tuxedo-spiderman", name: "Tuxedo Spider-Man", price_paise: 39900, image: "x.jpg", visible: 1 },
  { slug: "new-figure", name: "Naruto Bust", price_paise: 39900, image: "x.jpg", visible: 1 },
  { slug: "katana-display-sword", name: "Display Sword", price_paise: 99900, image: "x.jpg", visible: 1 },
  { slug: "india-tricolor-map", name: "India Tricolor Map", price_paise: 29900, image: "x.jpg", visible: 1 },
];

// Honours the real WHERE clause by reading it off the SQL, so dropping a filter
// changes what the fake returns.
const envWith = (rows = PRODUCTS, broken = false) => ({
  APP_NAME: "AswinPrints",
  APP_BASE_URL: "https://3d-prints.aswincloud.com",
  DB: { prepare(sql) {
    const s = sql.replace(/\s+/g, " ");
    return { async all() {
      if (broken) throw new Error("D1 down");
      return { results: rows.filter((r) =>
        (!/visible = 1/.test(s) || r.visible === 1) && (!/price_paise > 0/.test(s) || r.price_paise > 0)) };
    } };
  } },
});

console.log("\nfeed/google.xml");
{
  const res = await googleFeed(envWith());
  const xml = await res.text();
  const ids = [...xml.matchAll(/<g:id>(.*?)<\/g:id>/g)].map((m) => m[1]);

  ok("served as XML", /application\/xml/.test(res.headers.get("content-type") || ""));
  ok("RSS 2.0 with the Google namespace", xml.includes('xmlns:g="http://base.google.com/ns/1.0"'));
  ok("exactly the two sellable, allowed products", ids.join(",") === "ganesha-veena,golden-vase", ids.join(","));
  ok("hidden product left out", !ids.includes("hidden-thing"));
  ok("unpriced product left out", !ids.includes("quote-only"));
  ok("licensed character left out by slug", !ids.includes("tuxedo-spiderman"));
  ok("licensed character left out by name", !ids.includes("new-figure"));
  ok("weapon replica left out", !ids.includes("katana-display-sword"));
  ok("national emblem item left out", !ids.includes("india-tricolor-map"));
  ok("price in rupees with currency", xml.includes("<g:price>499.00 INR</g:price>"));
  ok("link is the product page", xml.includes("<g:link>https://3d-prints.aswincloud.com/p/ganesha-veena</g:link>"));
  ok("image is absolute", xml.includes("<g:image_link>https://3d-prints.aswincloud.com/assets/images/g.jpg?v=1</g:image_link>"));
  ok("gallery images included", xml.includes("<g:additional_image_link>https://3d-prints.aswincloud.com/assets/images/g2.jpg</g:additional_image_link>"));
  ok("text is escaped", xml.includes("Idol &amp; &lt;gift&gt;") && !xml.includes("<gift>"));
  ok("empty description gets a fallback", xml.includes("Golden Vase, 3D printed to order"));
  ok("no GTIN claimed", (xml.match(/<g:identifier_exists>no<\/g:identifier_exists>/g) || []).length === 2);
}
{
  // Merchant Center reads a missing item as "delete it", so a DB failure must
  // be an error the route turns into a 500, never an empty feed.
  let threw = false;
  try { await googleFeed(envWith(PRODUCTS, true)); } catch { threw = true; }
  ok("a DB failure throws instead of serving an empty feed", threw);
}
ok("inFeed keeps ordinary products", inFeed({ slug: "laughing-buddha", name: "Laughing Buddha" }));
ok("inFeed keeps the PS5 stand out", !inFeed({ slug: "ps5-horizontal-stand", name: "PS5 Horizontal Stand" }));

console.log("\nfree delivery in the feed");
{
  const flat = await (await googleFeed(envWith())).text();
  ok("no per-item shipping while shipping is charged", !flat.includes("<g:shipping>"));
  const free = await (await googleFeed({ ...envWith(), FLAT_SHIP_PAISE: "0" })).text();
  const items = (free.match(/<item>/g) || []).length;
  const ships = (free.match(/<g:shipping><g:country>IN<\/g:country><g:service>Standard<\/g:service><g:price>0\.00 INR<\/g:price><\/g:shipping>/g) || []).length;
  ok("every item says free delivery in India when shipping is free", items > 0 && ships === items, `${ships}/${items}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
