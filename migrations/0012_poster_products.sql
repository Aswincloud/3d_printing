-- 0012_poster_products.sql — treat the eight "Poster ..." rows as the products
-- they actually are.
--
-- I had this wrong. I read these as the marketing graphics being sold, because the
-- images ARE the Instagram graphics — 1080×1350 with "3D Print Hub",
-- "@3dprinthub.offl" and a "DM for a quote" panel burned in. Aswin ships the real
-- print; the graphic was just doing duty as the product photo. So this was never a
-- listing problem, only a photo problem, and the fix is the photo.
--
-- The eight JPEGs have been re-cropped in place: ad panel removed from the bottom,
-- badge band from the top, nothing else touched. What is left is a plain product
-- photo, landscape like every other one in the catalogue. Spider-Man and the
-- keychains were shifted horizontally because their subjects sit off-centre and the
-- card's own centre-crop would otherwise cut them.
--
-- The names still say "Poster", which now describes the old photo rather than the
-- product, so they are renamed to match the rest of the catalogue. Descriptions
-- come from what is visible in the (now cropped) photo, same as 0011.
--
-- Prices are NOT touched. One thing worth a look though: Wall Staircase is ₹299
-- while Wall-Mounted Staircase Shelf is ₹399 for what looks like the same print
-- photographed twice — see the note at the bottom.

UPDATE products SET
  name = 'Corner Spiral Staircase Wall Decor',
  category = 'decor',
  description = 'Corner-mounted spiral staircase in miniature — grey treads winding down inside a white railing, with two red panelled doors, a planter of grass and a tiny window box. Mounts across an inside corner so the stairs appear to climb the wall.',
  updated_at = 1786070000000
WHERE slug = 'poster-corner-staircase';

UPDATE products SET
  name = 'Fairy Cottage Hanging Ornaments',
  category = 'decor',
  description = 'Pair of cottage ornaments with deeply layered shingle roofs, a round chimney and an arched door, hung from a cord loop at the peak. Printed in wood-effect brown. Sized for a tree branch or a window.',
  updated_at = 1786070000000
WHERE slug = 'poster-fairy-cottage';

UPDATE products SET
  name = 'Hexagon Tree Wall Art',
  category = 'decor',
  description = 'Seven interlocking hexagons in matte black, the branches of a single tree running continuously from one frame into the next. Hangs as one honeycomb cluster; open centres let the wall colour through.',
  updated_at = 1786070000000
WHERE slug = 'poster-hexart';

UPDATE products SET
  name = 'Personalised Name Keychain',
  category = 'functional',
  description = 'Your name in raised script on a contrasting backing plate, with a flower, star or heart charm and a split ring. Any name, any two colours — tell me what you want when you order.',
  updated_at = 1786070000000
WHERE slug = 'poster-keychains';

UPDATE products SET
  name = 'Wall-Crawl Spider-Man Figurine',
  category = 'figurine',
  description = 'Spider-Man in a crawling pose, weight on one hand, the web pattern and muscle sculpt cut clean across the whole body. Printed unpainted in cream, ready to display as-is or paint yourself.',
  updated_at = 1786070000000
WHERE slug = 'poster-spiderman';

UPDATE products SET
  name = 'Tree Branch Lantern',
  category = 'decor',
  description = 'Gnarled tree-branch lamp post with a hanging lantern, hand-painted in bark browns with amber panes that glow warm when lit. Stands on a rooted base. A small desk or shelf light.',
  updated_at = 1786070000000
WHERE slug = 'poster-tree-lantern';

UPDATE products SET
  name = 'Vintage Spindle Wall Shelf',
  category = 'functional',
  description = 'Wall shelf in crisp white with a row of turned spindles along the back edge and softly scrolled brackets beneath. Holds small pieces — a plant, a figurine, keys.',
  updated_at = 1786070000000
WHERE slug = 'poster-wall-shelf';

UPDATE products SET
  name = 'Floating Staircase Wall Decor',
  category = 'decor',
  description = 'Staircase that appears to run up the wall: a landing with a panelled door at the top, railed steps descending to a lower deck, and a mullioned window on a scrolled bracket. Crisp white, mounts flush.',
  updated_at = 1786070000000
WHERE slug = 'poster-wall-staircase';

-- ⚠ WORTH A LOOK, not changed here:
--
-- 'poster-wall-staircase' (₹299, now Floating Staircase Wall Decor) and
-- 'wall-staircase-shelf' (₹399, Wall-Mounted Staircase Shelf) look like the same
-- print photographed twice — the same landing, door, railing and window bracket.
-- If they are the same piece, one should go and the other keep the better photo.
-- If they are different sizes or variants, the names should say which is which,
-- because right now a customer sees two near-identical listings ₹100 apart.
-- Left alone because I cannot tell from the photos, and guessing would either
-- delete a real product or leave a duplicate.
