#!/usr/bin/env bash
# Verifies 0011_product_descriptions.sql against whichever D1 it is pointed at.
#
#   bash test/verify-0011.sh --local
#   bash test/verify-0011.sh --remote
#
# It asserts COVERAGE, not just per-row conditions. The first version printed
# "all 10 hidden ✓" while matching ZERO rows — [].every() is true, and those rows
# only exist on production. A check that passes on an empty result set is worse
# than no check, because it reports success.
#
# 0011 is wording only. It used to also check that the eight poster rows had been
# hidden as non-products; that conclusion was wrong — Aswin ships the real print,
# and the ad graphic was only standing in as the product photo — so those rows are
# renamed and described by 0012 instead, and test/verify-0012.sh covers them.
set -uo pipefail
FLAG="${1:---local}"
cd "$(dirname "$0")/.."

npx wrangler d1 execute 3dprints-db "$FLAG" --json --command \
 "SELECT slug, name, LENGTH(description) len, visible FROM products
  WHERE slug IN ('dragon-sculpture','phoenix-mask','white-stork-figurine','red-horse',
                 'golden-vase','dahlia-flowers','dogs-rooster-set','phone-stand-figure',
                 'wall-staircase-shelf','poster-corner-staircase','poster-fairy-cottage',
                 'poster-hexart','poster-keychains','poster-spiderman','poster-tree-lantern',
                 'poster-wall-shelf','poster-wall-staircase','full-collection','toothless-collection')
  ORDER BY slug" 2>/dev/null \
 | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = JSON.parse(s.slice(s.indexOf("[")))[0].results;

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
  let fail = 0;
  const seenR = [];
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
  }

  // The part that matters: every expected slug must have been PRESENT.
  const missR = Object.keys(REWRITE).filter(x => !seenR.includes(x));
  if (missR.length) { console.log(`  NOT PRESENT (rewrite): ${missR.join(", ")}`); fail++; }
  console.log(`\n  rewritten ${seenR.length}/9 — ` +
    (fail ? `${fail} problem(s)` : "all present and correct"));
  process.exit(fail ? 1 : 0);
});'
