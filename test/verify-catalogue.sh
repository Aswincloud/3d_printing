#!/usr/bin/env bash
# Standing catalogue check — invariants that should hold for every listed product,
# not facts about one migration.
#
#   bash test/verify-catalogue.sh --remote
#
# Exists because the description work was done product by product across four
# migrations, and nothing would notice a new listing shipping empty. The next photo
# Aswin pushes becomes a synthesised quote-only card with no description at all,
# which is fine; the moment it is given a price it should also have words.
set -uo pipefail
FLAG="${1:---remote}"
cd "$(dirname "$0")/.."

npx wrangler d1 execute 3dprints-db "$FLAG" --json --command \
 "SELECT slug, name, category, price_paise, LENGTH(description) len
  FROM products WHERE visible = 1 ORDER BY slug" 2>/dev/null \
 | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = JSON.parse(s.slice(s.indexOf("[")))[0].results;
  let fail = 0;

  // Coverage first, always: an empty result set must not read as success.
  if (rows.length < 20) {
    console.log(`  FAIL only ${rows.length} visible products — wrong database?`);
    process.exit(1);
  }

  const thin = rows.filter((r) => r.len < 60);
  if (thin.length) {
    console.log(`  FAIL ${thin.length} listed product(s) with no real description:`);
    thin.forEach((r) => console.log(`         ${r.slug} (${r.len}c)`));
    fail++;
  }

  // "Poster" described the ad graphic that used to be the product photo. If it
  // comes back, a marketing image has been listed as a product again.
  const poster = rows.filter((r) => /^Poster /.test(r.name));
  if (poster.length) {
    console.log(`  FAIL ${poster.length} product(s) still named "Poster ...":`);
    poster.forEach((r) => console.log(`         ${r.slug} — ${r.name}`));
    fail++;
  }

  // price_paise > 0 is what priceCart requires; a visible row at 0 is a
  // quote-only card, which is legitimate, so this only reports the count.
  const quote = rows.filter((r) => !(r.price_paise > 0));

  const VALID = ["figurine", "decor", "functional", "set"];
  const badCat = rows.filter((r) => !VALID.includes(r.category));
  if (badCat.length) {
    console.log(`  FAIL ${badCat.length} product(s) with an unknown category:`);
    badCat.forEach((r) => console.log(`         ${r.slug} — "${r.category}"`));
    fail++;
  }

  console.log(`\n  ${rows.length} listed · ${quote.length} quote-only · ` +
    `${rows.length - thin.length}/${rows.length} described — ` +
    (fail ? `${fail} problem(s)` : "all good"));
  process.exit(fail ? 1 : 0);
});'
