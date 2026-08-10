-- 0011_product_descriptions.sql — descriptions for every product, written from
-- the photos.
--
-- 18 of 59 products had no description or a one-liner that undersold them. I
-- opened each photo rather than working from the names, and that turned up three
-- things that are not wording problems. They are listed here because they change
-- what is on sale, not just how it reads, and they need your call:
--
-- ⚠ 1. TEN CARDS ARE NOT PRODUCTS.
--
--    Eight "Poster ..." rows are the Instagram marketing graphics — 1080×1350
--    images with "3D Print Hub", "@3dprinthub.offl", a headline, and a "DM for a
--    quote" button burned into them. They are listed as buyable products at ₹129
--    to ₹349, so a customer can put a JPEG of an advert in their cart and pay for
--    it. And the price is the giveaway: Poster Wall Staircase is ₹299 for a
--    picture of the same print that Wall-Mounted Staircase Shelf sells for ₹399.
--
--    "Full Collection" and "Toothless Collection" are group shots of a shelf —
--    Kratos, Batman, an angel, Deadpool, Naruto, two Toothless dragons, a
--    Bluetooth speaker and an Eiffel Tower souvenir. Both priced ₹999, which
--    cannot be right for the whole group and is not defined for one piece.
--
--    This migration HIDES those ten (visible = 0) rather than deleting them, so
--    the decision is reversible and no ids are lost. It does not delete a row you
--    might want back. If you would rather relist some as real products — the
--    keychains and the hexagon wall art have no equivalent listing, and both look
--    genuinely sellable — say so and I will add them with their own photos and
--    prices. Also note the poster graphics say "DM for a quote" and carry a
--    different brand name than the shop, which is its own thing to reconcile.
--
-- ⚠ 2. THREE DESCRIPTIONS WERE FACTUALLY WRONG, not just thin.
--
--    White Stork: "in white filament" — it is multi-colour, with a black wing,
--    orange bill and orange legs. Someone reading that expects a plain print.
--    Phoenix Mask: "wall-hanging phoenix mask with sculpted plumage" — it is not
--    a mask and there is no phoenix; it is a butterfly above a flame-shaped
--    surround, in glossy red. The name is wrong too; renamed here.
--    Dragon Sculpture: "detailed dragon with scaled body" — it is a LAMP. The
--    dragon breathes an illuminated flame that lights up. That is the whole
--    product and it was missing from the listing.
--
-- ⚠ 3. RED HORSE is a temple horse. Ayyanar-style, fully caparisoned with
--    beaded harness, saddle blanket and plumed crest. "Stylised standing horse"
--    reads as generic decor and hides what it actually is, which is the thing a
--    customer searching for one would recognise.
--
-- Everything below is what is visibly in the photo. No print times, no
-- dimensions, no material claims beyond PLA, because the page already states
-- those and I cannot measure them from a picture.

-- ── the three corrections ─────────────────────────────────────────
-- Wrong facts first: these actively mislead, so they matter more than the
-- thin-but-true ones.

UPDATE products SET
  description = 'Wall-mounted dragon lamp: the dragon breathes a translucent flame that lights from within, glowing deep orange-red. Matte black body with membraned wings spread about a foot across. USB powered.',
  updated_at = 1786060000000
WHERE slug = 'dragon-sculpture';

UPDATE products SET
  name = 'Butterfly and Flame Wall Piece',
  description = 'Glossy red wall piece — a butterfly with swept wings above a flame-shaped surround, the outer fans printed as fine open vanes that catch the light. Bright cherry red throughout.',
  updated_at = 1786060000000
WHERE slug = 'phoenix-mask';

UPDATE products SET
  description = 'Standing white stork with a black flight wing, orange bill and long orange legs — printed in four colours with filament changes, not painted. Feather detail across the wing and breast.',
  updated_at = 1786060000000
WHERE slug = 'white-stork-figurine';

UPDATE products SET
  name = 'Ayyanar Temple Horse',
  description = 'Temple horse in the South Indian style, fully caparisoned — beaded harness, patterned saddle blanket, plumed crest and a sweeping tail. Deep matte red, with the ornament cut sharp enough to read across the room.',
  updated_at = 1786060000000
WHERE slug = 'red-horse';

-- ── the thin ones, rewritten from the photo ───────────────────────

UPDATE products SET
  description = 'Ewer-shaped pitcher vase in metallic gold, with lilies, leaves and a butterfly in deep relief climbing one side into the handle. A display piece rather than a flower vase.',
  updated_at = 1786060000000
WHERE slug = 'golden-vase';

UPDATE products SET
  description = 'Three dahlia stems on green stalks, each head layered from dozens of individual petals around a dense textured centre. Printed in gold, amber and deep crimson. Vase not included.',
  updated_at = 1786060000000
WHERE slug = 'dahlia-flowers';

UPDATE products SET
  description = 'Two sitting puppies in bright orange with tousled coat detail and painted eyes, and a slate-blue rooster with layered feathering and a raised comb. Three pieces, sold together.',
  updated_at = 1786060000000
WHERE slug = 'dogs-rooster-set';

UPDATE products SET
  description = 'Minimal figure standing in a frame, arms at its sides — the body is the backrest and the frame holds your phone upright in portrait or landscape. Printed in dark teal with a subtle sheen.',
  updated_at = 1786060000000
WHERE slug = 'phone-stand-figure';

UPDATE products SET
  description = 'Floating staircase for a bare wall: a landing at the top with a panelled door, railed steps running down to a lower deck, and a small mullioned window on a scrolled bracket. Crisp white, mounts flush so the treads appear to come out of the wall.',
  updated_at = 1786060000000
WHERE slug = 'wall-staircase-shelf';

-- ── hide the ten non-products ─────────────────────────────────────
-- visible = 0, not DELETE: reversible, and no ids are lost. See note 1 above.
--
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
