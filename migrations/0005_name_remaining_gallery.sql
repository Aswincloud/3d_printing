-- 0005_name_remaining_gallery.sql — identify the 18 previously-unnamed photos.
--
-- These all carried alt="3D print sample" in the gallery, so 0002 couldn't seed
-- them: there was no name to use and no basis for a price. I've now looked at
-- each photo and named it from what's visibly in it.
--
-- ⚠ TWO THINGS TO CHECK BEFORE THESE GO ON SALE — both rows are seeded
--   visible = 0 for that reason:
--
--   1. PRICES ARE PLACEHOLDERS AGAIN. They follow the same four bands as 0002
--      (₹349 / ₹549 / ₹899 / ₹1299) chosen from apparent size and complexity,
--      not filament weight or print time. The rest of the catalogue has since
--      been repriced by hand, so these are the odd ones out and will look
--      inconsistent until corrected.
--
--   2. Some depict third-party IP or need a judgement call — see the notes on
--      the individual rows. Everything questionable is visible = 0.
--
-- The bulk editor at /shop makes correcting the prices one pass rather than 18.

INSERT OR IGNORE INTO products
  (id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at)
VALUES

-- ── clearly sellable, original work ───────────────────────────────
('097b0604-3809-47d4-8b75-bb7bf406a6b5', 'hummingbird-on-blossom',
 'Hummingbird on Blossom',
 'Hummingbird in flight above a flowering base, wings raised. Printed in deep purple over an orange plinth.',
 54900, 'assets/images/IMG20260413101327.jpg', '', 'figurine', 1, 400, 1785840000000, 1785840000000),

('1eecabff-1096-45c8-9f39-f1c5d35818b3', 'lookout-tower',
 'Lookout Tower',
 'Two-storey timber-frame watchtower with railed decks, a ladder between levels and a glazed cabin. A tall, detailed architectural piece.',
 89900, 'assets/images/IMG20260413101336.jpg', '', 'decor', 1, 410, 1785840000000, 1785840000000),

('bd2cebda-c342-47df-83e0-6f2a21adae73', 'fairy-cottage',
 'Fairy Cottage',
 'Whimsical round cottage with a tall shingled roof, crooked chimney, arched door and a clover finial. Comes on a turned base.',
 89900, 'assets/images/IMG20260413101352_01.jpg', '', 'decor', 1, 420, 1785840000000, 1785840000000),

('20d71547-eceb-4186-a3af-a760a3d020f3', 'spiral-marble-run',
 'Spiral Marble Run',
 'Helical marble track that a ball descends by gravity, with a catch cup at the base. Print-in-place — no assembly.',
 89900, 'assets/images/IMG20260413120817.jpg', '', 'functional', 1, 430, 1785840000000, 1785840000000),

('01a64491-47f4-42f2-a95e-d25de68b9361', 'kinetic-spiral-sculpture',
 'Kinetic Spiral Sculpture',
 'Concentric stepped rings rising to a central spindle, giving a moiré effect as you move around it. Sits flat on a shelf or desk.',
 54900, 'assets/images/IMG20260413120832.jpg', '', 'decor', 1, 440, 1785840000000, 1785840000000),

('2bb4dffa-bdd7-4b77-9b61-445f63d940c6', 'switchback-marble-run',
 'Switchback Marble Run',
 'Standing marble run with looping switchback ramps on a braced frame. Larger sibling of the spiral run.',
 89900, 'assets/images/IMG20260413120901.jpg', '', 'functional', 1, 450, 1785840000000, 1785840000000),

('051672f5-c92c-4a56-8528-e767b9b9b73c', 'kinetic-spinner-disc',
 'Kinetic Spinner Disc',
 'Hand-held disc whose green lattice spins against a red backing plate — a fidget piece with a two-colour print.',
 34900, 'assets/images/IMG20260413120934.jpg', '', 'figurine', 1, 460, 1785840000000, 1785840000000),

('afc41157-bb99-4605-bd01-5e0ae8c2a521', 'monster-truck',
 'Monster Truck',
 'Open-top off-roader on oversized treaded tyres with sprung suspension, roll cage and moulded seats. Printed in four colours.',
 89900, 'assets/images/IMG20260413120943.jpg', '', 'figurine', 1, 470, 1785840000000, 1785840000000),

('b82d1eb4-60f9-4675-9177-32054e1c3aba', 'man-in-the-moon-climber',
 'Climbing to the Moon',
 'Figure in a hat climbing a ladder from a cloud bank towards a crescent moon with a sculpted face. A storybook scene on a round base.',
 89900, 'assets/images/IMG20260413120952.jpg', '', 'decor', 1, 480, 1785840000000, 1785840000000),

('42ff7a05-60d6-48a8-8893-a4e749425b6a', 'helicopter-model',
 'Helicopter',
 'Small pearl-white helicopter with a free-spinning main rotor and skid landing gear.',
 34900, 'assets/images/IMG20260413120958.jpg', '', 'figurine', 1, 490, 1785840000000, 1785840000000),

('a881c651-3a9f-40ff-b38a-9baedd76acc1', 'butterfly-lantern',
 'Butterfly Lantern',
 'Two-tier lantern in green and red with leaf relief and large veined butterfly wings across the top.',
 54900, 'assets/images/IMG20260413121014.jpg', '', 'decor', 1, 500, 1785840000000, 1785840000000),

('34f53f19-3833-4f41-a99d-1f6e960b3a7a', 'patterned-elephant',
 'Patterned Elephant',
 'Standing elephant covered in swirling engraved paisley, in metallic purple. Distinct from the plain Elephant Sculpture.',
 54900, 'assets/images/IMG20260413121041.jpg', '', 'figurine', 1, 510, 1785840000000, 1785840000000),

('ee29dcc5-0377-4374-96cb-ca66fb86b173', 'lion-on-rock',
 'Lion on a Rock',
 'Male lion seated on a rocky outcrop, full mane picked out in fine detail. Printed in bright orange.',
 54900, 'assets/images/IMG20260413121047.jpg', '', 'figurine', 1, 520, 1785840000000, 1785840000000),

('7c4ae58d-27e9-4d51-81d8-90403956b9a9', 'filigree-rearing-horse',
 'Filigree Rearing Horse',
 'Rearing horse rendered entirely in swirling openwork scrollwork, in cobalt blue. Distinct from the solid Red Horse.',
 89900, 'assets/images/IMG20260413121100.jpg', '', 'figurine', 1, 530, 1785840000000, 1785840000000),

-- ── seeded HIDDEN — needs a decision before it sells ─────────────

-- Evolution of Man, ending with a rider pulling a wheelie on a dirt bike. The
-- "March of Progress" figure sequence is a widely reproduced motif rather than
-- a protected character, but the joke is a specific mash-up someone designed.
-- Hidden pending a check on where the model came from.
('9d7391b5-47c8-4240-b4e2-a50341c924b9', 'evolution-dirt-bike',
 'Evolution to Dirt Bike',
 'The march-of-evolution silhouette, ending not in a walking man but a rider pulling a wheelie. One-piece print on a bar base.',
 89900, 'assets/images/IMG20260216170453.jpg', '', 'decor', 0, 540, 1785840000000, 1785840000000),

-- A REPLICA FIREARM. Marked as a pistol on the slide, roughly full size.
-- Selling replica firearms online in India runs into the Arms Act and, quite
-- separately, into Razorpay's restricted-goods list — an aggregator can freeze
-- a merchant account over this. Not a judgement about the print; a judgement
-- about listing it for sale. Left in the gallery, hidden from the shop.
('32cd2d9e-8bd4-46e6-8594-91347a5dfa6e', 'desert-eagle-replica',
 'Desert Eagle Replica (display model)',
 'Non-functional display replica of a Desert Eagle pistol, printed in red, white and blue. HIDDEN: replica firearms are a restricted category for payment aggregators and may be regulated for sale — confirm before listing.',
 89900, 'assets/images/IMG20260413120919.jpg', '', 'figurine', 0, 550, 1785840000000, 1785840000000),

-- Katana. Not a replica firearm, but a ~60cm bladed-weapon likeness, so worth
-- the same check before it's buyable.
('c9a5e4cb-e5a4-4572-9876-beda29d170d2', 'katana-display-sword',
 'Katana (display piece)',
 'Full-length katana with a wrapped-effect grip and round guard, printed in orange. Decorative, not sharpened. HIDDEN: confirm you are happy selling a bladed-weapon likeness before listing.',
 89900, 'assets/images/IMG20260413120850.jpg', '', 'decor', 0, 560, 1785840000000, 1785840000000),

-- The Little Prince: boy with wild hair on an asteroid, fox beside him, rose in
-- hand. Saint-Exupéry's text is public domain in India, but the character's
-- visual likeness is heavily licensed and this is unmistakably it. Same
-- treatment as the other licensed items.
('b34f8685-a5c0-462c-b446-91094ed84cfd', 'little-prince-scene',
 'Little Prince on His Planet',
 'Boy with wild hair seated on a cratered asteroid, fox at his side, holding a red rose. Two-colour print on a square base. HIDDEN: licensed character likeness — same call as the other IP pieces.',
 129900, 'assets/images/IMG20260413121113.jpg', '', 'set', 0, 570, 1785840000000, 1785840000000);
