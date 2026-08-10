#!/usr/bin/env bash
# Verifies 0012_poster_products.sql — the eight re-cropped poster products.
#
#   bash test/verify-0012.sh --remote     # these rows are production-only
#
# Asserts COVERAGE first: every expected slug must be PRESENT. The rows do not
# exist in the local D1, so a per-row check alone reports success against an empty
# result set — which is exactly how an earlier version of verify-0011.sh claimed
# "all 10 hidden ✓" while matching nothing.
set -uo pipefail
FLAG="${1:---remote}"
cd "$(dirname "$0")/.."

npx wrangler d1 execute 3dprints-db "$FLAG" --json --command \
 "SELECT slug, name, category, LENGTH(description) len, visible, image
  FROM products WHERE slug LIKE 'poster-%' ORDER BY slug" 2>/dev/null \
 | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = JSON.parse(s.slice(s.indexOf("[")))[0].results;

  // slug -> [expected name, expected category]
  const WANT = {
    "poster-corner-staircase": ["Corner Spiral Staircase Wall Decor", "decor"],
    "poster-fairy-cottage":    ["Fairy Cottage Hanging Ornaments",    "decor"],
    "poster-hexart":           ["Hexagon Tree Wall Art",              "decor"],
    "poster-keychains":        ["Personalised Name Keychain",         "functional"],
    "poster-spiderman":        ["Wall-Crawl Spider-Man Figurine",     "figurine"],
    "poster-tree-lantern":     ["Tree Branch Lantern",                "decor"],
    "poster-wall-shelf":       ["Vintage Spindle Wall Shelf",         "functional"],
    "poster-wall-staircase":   ["Floating Staircase Wall Decor",      "decor"],
  };

  let fail = 0;
  const seen = [];
  for (const r of rows) {
    const want = WANT[r.slug];
    if (!want) continue;
    seen.push(r.slug);
    const [name, cat] = want;
    if (r.name !== name) { console.log(`  FAIL name: ${r.slug} is "${r.name}"`); fail++; }
    // The whole point of the rename: "Poster" described the old ad-graphic photo,
    // not the product.
    if (/^Poster /.test(r.name)) { console.log(`  FAIL still named Poster: ${r.slug}`); fail++; }
    if (r.category !== cat) { console.log(`  FAIL category: ${r.slug} is "${r.category}", want "${cat}"`); fail++; }
    if (r.len < 60) { console.log(`  FAIL description thin (${r.len}c): ${r.slug}`); fail++; }
    // These are real products, so they must stay on sale.
    if (r.visible !== 1) { console.log(`  FAIL not visible: ${r.slug}`); fail++; }
  }

  const missing = Object.keys(WANT).filter(x => !seen.includes(x));
  if (missing.length) { console.log(`  NOT PRESENT: ${missing.join(", ")}`); fail++; }

  console.log(`\n  ${seen.length}/8 poster products checked — ` +
    (fail ? `${fail} problem(s)` : "renamed, recategorised, described, on sale"));
  process.exit(fail ? 1 : 0);
});'
