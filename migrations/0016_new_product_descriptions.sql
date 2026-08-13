-- 0016_new_product_descriptions.sql — descriptions for the four products added on
-- 13 Aug, written from the photos.
--
-- All four went live priced but with an empty description and every one filed as
-- 'figurine', including a fruit bowl and a console stand. test/verify-catalogue.sh
-- caught them, which is what it was added for.
--
-- ⚠ THREE THINGS THAT ARE NOT WORDING, and need your call:
--
-- 1. banana_bowl.jpg IS NOT A PHOTO OF YOUR PRINT. It is a rendered image — three
--    bowls on a marble counter in front of a garden window, with the depth of field
--    and the light of a stock kitchen shot. Every other product on the shop is
--    photographed on your own table or wall. A customer comparing what arrives to
--    that picture will be comparing it to a render, which is the kind of gap that
--    produces a refund request rather than a complaint. Send a photo of the real
--    bowl and I will swap it in.
--
-- 2. The same image shows THREE SIZES at one price of ₹399. The description says the
--    bowl is made in three sizes and asks the buyer to state which, because that is
--    honest with the photo and fits a made-to-order shop. If the three sizes should
--    be priced differently, they need to be separate listings.
--
-- 3. The PS5 stand carries the PlayStation glyph and the PS5 wordmark embossed in
--    the part, and Venom is a Marvel character. 0005 hid several rows over exactly
--    this, and you have since listed Spider-Man at ₹12,000 and the Batman & Angel
--    set, so I have treated these the same way and left them visible rather than
--    reopening a decision you have already made. Flagging it, not arguing it.
--
-- The PS5 description also asks which console model the buyer has. The PS5 shipped
-- in more than one body size, and a cradle printed for one does not necessarily grip
-- another — better to ask on the listing than to post a stand that does not fit.

UPDATE products SET
  category = 'figurine',
  description = 'Crouching symbiote figure, one clawed hand raised and jaws open wide over a lashing tongue. Heavy sculpted musculature with the chest emblem and web-lines cut into the surface. Printed unpainted in light grey — display it as it comes or paint it yourself.',
  updated_at = 1786110000000
WHERE slug = 'venom';

UPDATE products SET
  category = 'functional',
  description = 'Fruit bowl built from upright banana forms, stems meeting at the rim so the whole bowl reads as one bunch. Printed in ripe yellow with darker stem tips. Deep enough for apples and oranges, and open-sided so nothing sweats. Made in three sizes — say which you would like when you order.',
  updated_at = 1786110000000
WHERE slug = 'banana-bowl';

UPDATE products SET
  category = 'decor',
  description = 'Relief map of India in the flag''s three colours, with the Ashoka Chakra and its twenty-four spokes picked out in blue at the centre. The surface carries real terrain: the Himalaya stand proud along the northern edge and the Deccan reads as raised ground. Printed in four colours with filament changes, not painted. Sits flat on a shelf or mounts on a wall.',
  updated_at = 1786110000000
WHERE slug = 'india-tricolor-map';

UPDATE products SET
  category = 'functional',
  description = 'Cradle that holds a PS5 on its side, gripping the console front and back so it sits level and lifted clear of the shelf. Hex-perforated along the front so the intake is not blocked, with the console wordmark embossed in the face. Printed here in pale blue; any colour on request. The PS5 shipped in more than one body size, so tell me which model you have when you order.',
  updated_at = 1786110000000
WHERE slug = 'ps5-horizontal-stand';
