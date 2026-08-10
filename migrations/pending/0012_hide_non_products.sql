-- 0012_hide_non_products.sql — withdraw ten cards that are not products.
--
-- ⚠ NOT APPLIED. Aswin chose to keep these on sale for now and decide separately,
--   so this is split out of 0011 and left here deliberately. `wrangler d1
--   migrations apply` runs everything unapplied in order — if you apply a later
--   migration, this one goes with it. Delete this file, or apply it, rather than
--   leaving it to be swept along by accident.
--
-- ── what these are ───────────────────────────────────────────────────────────
--
-- Eight "Poster ..." rows are the Instagram marketing graphics themselves —
-- 1080×1350 images with "3D Print Hub", "@3dprinthub.offl", a headline and a
-- "DM for a quote" button burned into the pixels. They are listed as buyable
-- products at ₹129–₹349, so a customer can put a JPEG of an advert in their cart
-- and pay for it. The pricing gives it away: Poster Wall Staircase is ₹299 for a
-- picture of the same print that Wall-Mounted Staircase Shelf sells for ₹399.
--
-- Two more are group shots of a shelf. Full Collection is Kratos, Batman, an
-- angel, Deadpool, Naruto, two Toothless dragons, a Bluetooth speaker and an
-- Eiffel Tower souvenir; Toothless Collection is four of those again. Both are
-- priced ₹999, which is neither the price of the group nor defined for one piece.
--
-- Several also depict third-party IP (Spider-Man, Toothless, Kratos, Deadpool,
-- Naruto, Batman) which 0005 hid other rows for.
--
-- ── if you apply this ────────────────────────────────────────────────────────
--
-- visible = 0, never DELETE: reversible with one column, and no ids are lost.
-- order_items snapshots product and price at purchase, so no past order changes.
-- The only order against any of these is receipt AP-dd41da17 — Aswin's own ₹448
-- test, marked shipped.
--
-- Listed catalogue goes 59 → 49. The sitemap follows automatically (seo.js filters
-- on visible = 1 AND price_paise > 0), so those URLs drop out on the next crawl.
--
-- Two of the eight look genuinely sellable as real products and have no equivalent
-- listing today: the personalised name keychains and the hexagon tree wall art.
-- Relisting them needs a photo of the print itself rather than the poster, and a
-- price. Say the word and I will add them.

-- Eight Instagram marketing graphics, currently buyable at ₹129–₹349:
UPDATE products SET visible = 0, updated_at = 1786060000000
WHERE slug IN (
  'poster-corner-staircase',
  'poster-fairy-cottage',
  'poster-hexart',
  'poster-keychains',
  'poster-spiderman',
  'poster-tree-lantern',
  'poster-wall-shelf',
  'poster-wall-staircase'
);

-- Two group shots of a shelf, both priced ₹999 with no defined contents:
UPDATE products SET visible = 0, updated_at = 1786060000000
WHERE slug IN ('full-collection', 'toothless-collection');
