-- 0014_collection_descriptions.sql — describe the two collection listings.
--
-- Aswin confirmed ₹999 is the price for the WHOLE collection, not per piece. That
-- was the open question: the photos are group shots, and a group shot at a single
-- price is ambiguous in a way a customer resolves by not buying.
--
-- Written from the photos. Both descriptions lead with the count and say plainly
-- that the price is for the set, because that is the fact a shopper needs before
-- anything else, and it is the one the listing has never stated.
--
-- ── two things in the photos that are NOT for sale ───────────────────────────
--
-- Full Collection also shows a Bluetooth speaker (red, with volume buttons), an
-- astronaut-shaped disco lamp, and a metal Eiffel Tower souvenir. Toothless
-- Collection shows the same Eiffel Tower. None of those are prints — they are
-- props that happened to be on the floor.
--
-- A customer paying ₹999 for "everything in this photo" and receiving nine prints
-- but no speaker has a legitimate complaint, and it would be my listing that
-- created it. So both descriptions name what is included and explicitly exclude
-- the props. The alternative — reshooting without them — is better, and is noted
-- at the bottom, but a listing that is live today should not stay ambiguous while
-- waiting for a photo.
--
-- ── overlap with an existing listing ─────────────────────────────────────────
--
-- The Batman and the winged figure appear in BOTH collection photos AND as
-- 'batman-angel-set' at ₹599. That is not a duplicate the way the two staircases
-- were — a bundle legitimately contains pieces also sold separately — so nothing
-- is retired here. The Toothless description points at the separate listing, so
-- someone who only wants those two can find them.
--
-- ── prices ───────────────────────────────────────────────────────────────────
--
-- NOT changed, but worth a look. Both sets are ₹999 and they are not comparable:
-- Toothless Collection is 4 pieces (2 dragons, Batman, angel), Full Collection is
-- 9+. At ₹999 the Toothless set is already below Batman & Angel Set (₹599) plus
-- two dragons, and Full Collection works out near ₹110 a piece against a ₹549
-- median for a single figurine. Underpriced rather than wrong, and pricing is
-- yours, so this only writes the descriptions.
--
-- Category stays 'set' territory but both rows are 'figurine' today; changed to
-- 'set', which is what the sidebar filter already offers and what the other
-- multi-piece listings use.

UPDATE products SET
  category = 'set',
  description = 'Nine-piece display set, ₹999 for the whole collection. A god of war on a carved plinth, a caped hero in matte black, a winged figure in a flowing white gown, two night-dragons in black and metallic blue, a merc in red reading a tablet, a young ninja in orange, a small purple wizard and a crouching web-slinger. Hand-painted where the photo shows it. The speaker, lamp and Eiffel Tower in the picture are props, not part of the set.',
  updated_at = 1786090000000
WHERE slug = 'full-collection';

UPDATE products SET
  category = 'set',
  description = 'Four-piece display set, ₹999 for all four. Two night-dragons — one matte black with yellow eyes, one in metallic blue with its wings folded — alongside a caped hero in black on a round base and a winged figure in a white gown. The dragons are the pair the set is named for; the other two are also sold on their own as the Batman & Angel Set. The Eiffel Tower in the photo is a prop, not part of the set.',
  updated_at = 1786090000000
WHERE slug = 'toothless-collection';

-- ⚠ WORTH DOING, not done here: reshoot both without the speaker, lamp and Eiffel
--   Tower, on a plain surface. The descriptions currently have to talk the
--   customer out of things they can see in the photo, which is a caption doing a
--   photograph's job. Send new shots and I will swap them in.
