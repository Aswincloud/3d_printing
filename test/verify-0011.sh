# Verifies 0011 against whichever D1 it is pointed at. Refuses to report success
# on an empty result set — the first version of this check printed
# "all 10 hidden" while matching ZERO rows, because [].every() is true and the
# poster rows only exist on production.
set -uo pipefail
FLAG="$1"   # --local or --remote
cd /home/aswin/3d_printing
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
  const rows=JSON.parse(s.slice(s.indexOf("[")))[0].results;
  const HIDE=new Set(["poster-corner-staircase","poster-fairy-cottage","poster-hexart",
    "poster-keychains","poster-spiderman","poster-tree-lantern","poster-wall-shelf",
    "poster-wall-staircase","full-collection","toothless-collection"]);
  const REWRITE=new Set(["dragon-sculpture","phoenix-mask","white-stork-figurine","red-horse",
    "golden-vase","dahlia-flowers","dogs-rooster-set","phone-stand-figure","wall-staircase-shelf"]);
  let fail=0;
  const seenH=[], seenR=[];
  for(const r of rows){
    if(HIDE.has(r.slug)){ seenH.push(r.slug);
      if(r.visible!==0){ console.log(`  FAIL still visible: ${r.slug}`); fail++; } }
    if(REWRITE.has(r.slug)){ seenR.push(r.slug);
      if(r.len<60){ console.log(`  FAIL still thin (${r.len}c): ${r.slug}`); fail++; } }
  }
  // The important part: assert COVERAGE, not just per-row conditions.
  const missH=[...HIDE].filter(s=>!seenH.includes(s));
  const missR=[...REWRITE].filter(s=>!seenR.includes(s));
  if(missH.length){ console.log(`  NOT PRESENT (hide):    ${missH.join(", ")}`); fail++; }
  if(missR.length){ console.log(`  NOT PRESENT (rewrite): ${missR.join(", ")}`); fail++; }
  console.log(`\n  hidden ${seenH.length}/10, rewritten ${seenR.length}/9 — ${fail?fail+" problem(s)":"all present and correct"}`);
  process.exit(fail?1:0);
});'
