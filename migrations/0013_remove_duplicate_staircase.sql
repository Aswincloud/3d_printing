-- 0013_remove_duplicate_staircase.sql — one staircase, not two.
--
-- 'poster-wall-staircase' (₹299) and 'wall-staircase-shelf' (₹399) were the same
-- print listed twice, ₹100 apart. Aswin confirmed they are the same piece and
-- chose to remove the ₹299 one.
--
-- The two photos are the same shot: the poster graphic was built from
-- IMG20260729_wall_staircase.jpg, and 0012 cropped it back out of the poster. So
-- the survivor already holds the better original — 1599×1200 against the poster's
-- 1080×666 — and there is no image worth carrying across.
--
-- ── why visible = 0 and NOT delete ───────────────────────────────────────────
--
-- I wrote this as a DELETE first. That would have put the duplicate straight back
-- on the shop.
--
-- src/shop.js synthesises a quote-only card for every photo in the manifest that
-- no product row uses, so a pushed photo appears in the shop without a code
-- change. Rows with visible = 0 count as "used" — deliberately, so that hiding a
-- product does not resurrect it as a synthesised card on the very next request.
--
-- Delete the row and poster_wall_staircase_v2.jpg stops being used by anything, so
-- the shop would list it again the next request: same print, third listing, this
-- time as "Poster Wall Staircase, Price on request". The delete would have undone
-- itself within seconds.
--
-- There is a live precedent already in the catalogue, which is how I noticed:
-- 'poster-wall-staircase-2' and 'poster-giveaway' are both visible = 0, and their
-- photos are exactly why neither shows up as a synthesised card today.
--
-- Deleting the JPEG as well would also work, but throwing away an original to make
-- a listing change is the wrong trade — the photo is the asset here, and it is the
-- source the good crop came from.

UPDATE products SET
  visible = 0,
  updated_at = 1786080000000
WHERE slug = 'poster-wall-staircase';

-- The survivor takes the better of the two descriptions. The copy written for the
-- poster row in 0012 is more specific about the mullioned window and the scrolled
-- bracket than the 0011 text, and there is no reason to lose the better wording
-- along with the duplicate listing.
UPDATE products SET
  description = 'Staircase that appears to run up the wall: a landing with a panelled door at the top, railed steps descending to a lower deck, and a small mullioned window on a scrolled bracket. Crisp white, mounts flush so the treads seem to come straight out of the wall.',
  updated_at = 1786080000000
WHERE slug = 'wall-staircase-shelf';
