-- Remove internal staging notes from customer-facing product descriptions.
--
-- Migrations 0002 and 0005 wrote notes to myself into `description`:
--   "LICENSED IP (DC) — hidden from the shop pending a decision on selling it."
--   "HIDDEN: replica firearms are a restricted category for payment aggregators…"
--   "HIDDEN: confirm you are happy selling a bladed-weapon likeness before listing."
--
-- That was safe only while those rows were visible = 0. All eight are now
-- visible = 1 with hand-set prices, and GET /api/products returns `description`
-- verbatim — so every visitor to the shop could read them. Confirmed live before
-- writing this: the public API returned all eight notes.
--
-- The lesson, and why this file exists rather than an edit to 0002/0005: a column
-- that ships to the browser is the wrong place for a private note. If a
-- staging/QA note is needed again it belongs in its own column (or an admin-only
-- field), not in one the catalogue endpoint selects.
--
-- 0002 and 0005 are left untouched. They have already been applied, and a
-- migration's recorded hash should match what ran.

UPDATE products SET description =
  'Hand-painted character figurine with fine surface detail. Printed to order.'
  WHERE slug = 'spiderman-figurine';

UPDATE products SET description =
  'Two hand-painted display figures — a caped hero in matte black and a winged figure in white with painted detail. Shown alongside a printed Eiffel Tower.'
  WHERE slug = 'batman-angel-set';

UPDATE products SET description =
  'Delicate winged fairy figurine with fine translucent wings. A light, detailed piece.'
  WHERE slug = 'tinkerbell-figurine';

UPDATE products SET description =
  'Small hand-painted bear figurine. A cheerful shelf or desk piece.'
  WHERE slug = 'carebear-figurine';

UPDATE products SET description =
  'Scale model aircraft with a detailed fuselage and prop. A display piece for a desk or shelf.'
  WHERE slug = 'tbm900-aircraft';

UPDATE products SET description =
  'Non-functional display replica, printed in red, white and blue. Solid plastic, no moving parts — a display piece only.'
  WHERE slug = 'desert-eagle-replica';

UPDATE products SET description =
  'Full-length display katana in orange, with a wrapped-effect grip and round guard. Decorative and blunt — not sharpened.'
  WHERE slug = 'katana-display-sword';

UPDATE products SET description =
  'Boy with wild hair seated on a cratered asteroid, fox at his side, holding a red rose. Two-colour print on a square base.'
  WHERE slug = 'little-prince-scene';

-- Catch-all for any row seeded with a marker that the per-slug statements above
-- missed. Blanking is deliberate: an empty description renders as nothing, which
-- is better than showing a customer an internal note.
UPDATE products SET description = ''
  WHERE description LIKE '%LICENSED IP%'
     OR description LIKE '%HIDDEN:%'
     OR description LIKE '%pending a decision%';
