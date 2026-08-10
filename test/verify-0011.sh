#!/usr/bin/env bash
# Verifies 0011_product_descriptions.sql against whichever D1 it is pointed at.
#
#   bash test/verify-0011.sh --local
#   bash test/verify-0011.sh --remote
#   bash test/verify-0011.sh --remote --with-hides   # only after 0012 is applied
#
# It asserts COVERAGE, not just per-row conditions. The first version printed
# "all 10 hidden ✓" while matching ZERO rows — [].every() is true, and those rows
# only exist on production. A check that passes on an empty result set is worse
# than no check, because it reports success.
#
# 0011 is wording only. The hides live in migrations/pending/0012 and are NOT
# checked unless --with-hides is passed.
set -uo pipefail
FLAG="${1:---local}"
WITH_HIDES="${2:-}"
cd "$(dirname "$0")/.."

npx wrangler d1 execute 3dprints-db "$FLAG" --json --command \
 "SELECT slug, name, LENGTH(description) len, visible FROM products
  WHERE slug IN ('dragon-sculpture','phoenix-mask','white-stork-figurine','red-horse',
                 'golden-vase','dahlia-flowers','dogs-rooster-set','phone-stand-figure',
                 'wall-staircase-shelf','poster-corner-staircase','poster-fairy-cottage',
                 'poster-hexart','poster-keychains','poster-spiderman','poster-tree-lantern',
                 'poster-wall-shelf','poster-wall-staircase','full-collection','toothless-collection')
  ORDER BY slug" 2>/dev/null \
 | WITH_HIDES="$WITH_HIDES" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = JSON.parse(s.slice(s.indexOf("[")))[0].results;
  const withHides = process.env.WITH_HIDES === "--with-hides";

  // 0011: nine rewritten descriptions, two of them also renamed. Asserting the
  // rename as well as the length, because a length check alone would pass on the
  // old wrong name with new text under it.
  const REWRITE = {
    "dragon-sculpture":     null,
    "phoenix-mask":         "Butterfly and Flame Wall Piece",
    "white-stork-figurine": null,
    "red-horse":            "Ayyanar Temple Horse",
    "golden-vase":          null,
    "dahlia-flowers":       null,
    "dogs-rooster-set":     null,
    "phone-stand-figure":   null,
    "wall-staircase-shelf": null,
  };
  const HIDE = ["poster-corner-staircase","poster-fairy-cottage","poster-hexart",
    "poster-keychains","poster-spiderman","poster-tree-lantern","poster-wall-shelf",
    "poster-wall-staircase","full-collection","toothless-collection"];

  let fail = 0;
  const seenR = [], seenH = [];
  for (const r of rows) {
    if (r.slug in REWRITE) {
      seenR.push(r.slug);
      // 60 chars is the threshold that flagged these as thin in the first place.
      if (r.len < 60) { console.log(`  FAIL still thin (${r.len}c): ${r.slug}`); fail++; }
      const want = REWRITE[r.slug];
      if (want && r.name !== want) {
        console.log(`  FAIL not renamed: ${r.slug} is "${r.name}", expected "${want}"`); fail++;
      }
    }
    if (withHides && HIDE.includes(r.slug)) {
      seenH.push(r.slug);
      if (r.visible !== 0) { console.log(`  FAIL still visible: ${r.slug}`); fail++; }
    }
  }

  // The part that matters: every expected slug must have been PRESENT.
  const missR = Object.keys(REWRITE).filter(x => !seenR.includes(x));
  if (missR.length) { console.log(`  NOT PRESENT (rewrite): ${missR.join(", ")}`); fail++; }
  if (withHides) {
    const missH = HIDE.filter(x => !seenH.includes(x));
    if (missH.length) { console.log(`  NOT PRESENT (hide): ${missH.join(", ")}`); fail++; }
  }

  console.log(`\n  rewritten ${seenR.length}/9` +
    (withHides ? `, hidden ${seenH.length}/10` : " (hides not checked — 0012 is held)") +
    ` — ${fail ? fail + " problem(s)" : "all present and correct"}`);
  process.exit(fail ? 1 : 0);
});'
