-- 0017_new_product_descriptions.sql — descriptions for the four products added
-- most recently, priced but with an empty description, written from the photos.
--
-- test/verify-catalogue.sh flagged all four (LENGTH(description) < 60). Two were
-- also mis-categorised, filed 'figurine' regardless of what they are — corrected
-- below:
--   • gta6-stand   → functional  (it is a controller dock, not a figure)
--   • pikachu-wall-art → decor    (wall art that hangs, not a standing figure)
--
-- ⚠ LICENSED IP — your call, flagging not arguing:
--   • Batman is DC, GTA VI is Rockstar/Take-Two, Pikachu is Pokémon/Nintendo.
--     0005 hid several third-party-character rows over exactly this, but you have
--     since listed Spider-Man and the Batman & Angel set as visible, so I have
--     treated these the same and left them visible rather than reopening a
--     decision you have already made. Say the word and I'll hide any of them.

UPDATE products SET
  category = 'figurine',
  description = 'Standing Batman in the classic comic build — black cowl and scalloped cape, grey bodysuit with the black bat emblem across the chest, and a tan utility belt. Printed in three colours by filament change rather than paint, so the grey, black and belt are the plastic itself. The cape sweeps wide to either side and the figure stands unaided on its own boots.',
  updated_at = 1786960952616
WHERE slug = 'batman-figurine';

UPDATE products SET
  category = 'functional',
  description = 'Controller dock built from the Grand Theft Auto VI logo — the tall Roman VI in Vice City pink and blue with a palm-leaf fill, a black cradle behind it holding a PS5 DualSense at a slight tilt. Keeps the pad upright on your desk instead of face-down in a drawer, with the front cut low so you can lift it out one-handed. Printed in the pink, blue, white and black you see; other colours on request.',
  updated_at = 1786960952616
WHERE slug = 'gta6-stand';

UPDATE products SET
  category = 'decor',
  description = 'Pikachu mid-pounce mounted on a black shatter decal, so it reads as if it has just burst through the wall. Yellow body with black-tipped ears, brown back stripes and the lightning-bolt tail, all in the plastic with no paint. Hangs from the crack backing; the cracks spread wider than the figure, so leave a little clear space around it.',
  updated_at = 1786960952616
WHERE slug = 'pikachu-wall-art';

UPDATE products SET
  category = 'figurine',
  description = 'Radha and Krishna standing together — Krishna at the flute beneath a peacock-feather crown, Radha at his side in a pleated, ornamented sari, the pair raised on a round lotus-edged base. Printed in a single gold filament so the fall of the cloth and the fine crown detail catch the light. A devotional piece for a mandir shelf or pooja corner; stands on its own base.',
  updated_at = 1786960952616
WHERE slug = 'radha-krishna';
