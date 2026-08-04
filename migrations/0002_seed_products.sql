-- 0002_seed_products.sql — catalogue seeded from the gallery photos
--
-- ⚠ PRICES AND DESCRIPTIONS ARE PLACEHOLDERS. They are my estimates from
-- apparent size and complexity, not from filament weight or print time. Edit
-- them in the admin dashboard before live keys are enabled. While Razorpay is
-- in test mode no real money can move, so a wrong price here costs nothing yet.
--
-- Four price bands: ₹349 small · ₹549 mid · ₹899 large/complex · ₹1299 set.
--
-- How 35 named gallery photos became 31 products — I read every photo rather
-- than trusting the filenames, and the filenames mislead in four places:
--
--   * batman_angel.jpg / _topdown.jpg / _eiffel.jpg are ONE physical pair
--     photographed three times → one row, extra views in `images`.
--   * temple1.jpg and temple2.jpg are DIFFERENT prints (orange/brown two-tone
--     and larger vs. all-gold and smaller) → two rows, not one.
--   * dahlias.jpg (3 loose stems) and flowers_bouquet.jpg (~9 blooms in a
--     printed spiral vase) are DIFFERENT products → two rows, not one.
--   * buddha_icecream.jpg and vases_temple.jpg are group shots whose second
--     subject already has its own listing. Each is seeded as the item that is
--     otherwise unlisted — the praying baby Buddha, and the carved vase pair.
--
-- full_collection.jpg and toothless_collection.jpg are shelf/portfolio shots of
-- many pieces at once, not single sellable items, so they stay gallery-only.
--
-- The 18 photos with generic alt="3D print sample" get no product row until
-- they are named.
--
-- visible = 0 on five rows that depict third-party IP (Marvel, DC, Disney,
-- Cloudco, Daher). Showing them as portfolio photos is one thing; selling them
-- is commercial use of someone else's character, which is both a takedown risk
-- and an aggregator-compliance risk. They stay in the gallery either way, and
-- can be flipped visible per item once that call is made.

INSERT OR IGNORE INTO products
  (id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at)
VALUES
-- ── large / complex · ₹899 ─────────────────────────────────────────
('3556b750-bf25-414e-84b8-412335d7ef02', 'articulated-dino-skeleton',
 'Articulated Dinosaur Skeleton',
 'Print-in-place flexi skeleton — every vertebra and limb moves, no assembly needed. Speckled stone-grey filament.',
 89900, 'assets/images/IMG20260403160453.jpg', '', 'figurine', 1, 10, 1785801600000, 1785801600000),

('afee370d-408c-453c-bcd4-dc90608acea4', 'elephant-sculpture',
 'Elephant Sculpture',
 'Decorative elephant with detailed surface texture. A substantial display piece.',
 89900, 'assets/images/IMG20260725_elephant.jpg', '', 'figurine', 1, 20, 1785801600000, 1785801600000),

('1b44af1d-caad-488f-8d77-3a6422a216a1', 'murugan-temple-shrine',
 'Murugan Temple Shrine',
 'Multi-part shrine: deep-blue mandapam with carved pillars and domed vimana, housing a gold Murugan figure with vel. Printed in four colours.',
 89900, 'assets/images/IMG20260523_murugan_temple.jpg', '', 'decor', 1, 30, 1785801600000, 1785801600000),

('8203ae32-f64d-4ae0-8d20-660941ff273a', 'ganesha-veena',
 'Ganesha with Veena',
 'Seated Ganesha playing the veena, with fine relief detail throughout.',
 89900, 'assets/images/IMG20260531_ganesha_veena.jpg', '', 'decor', 1, 40, 1785801600000, 1785801600000),

('fd0b3299-635f-443f-a4f2-b5d29b454c9e', 'dragon-sculpture',
 'Dragon Sculpture',
 'Detailed dragon with scaled body and outstretched wings.',
 89900, 'assets/images/IMG20260521_dragon.jpg', '', 'figurine', 1, 50, 1785801600000, 1785801600000),

('fc20ddaf-0dfa-4f78-b8a5-99d335809260', 'phoenix-mask',
 'Phoenix Mask',
 'Wall-hanging phoenix mask with sculpted plumage.',
 89900, 'assets/images/IMG20260531_phoenix_mask.jpg', '', 'decor', 1, 60, 1785801600000, 1785801600000),

('23667655-91a8-44ab-b1aa-937170ae2698', 'articulated-robot',
 'Articulated Robot Figure',
 'Print-in-place robot with movable joints, ready to pose straight off the plate.',
 89900, 'assets/images/IMG20260725_robot_articulated.jpg', '', 'figurine', 1, 70, 1785801600000, 1785801600000),

('db24d325-df43-4e98-a889-a651f68e1377', 'jeep-4x4-model',
 'Jeep 4x4 Model',
 'Off-road 4x4 model with separately printed wheels and body panels.',
 89900, 'assets/images/IMG20260531_jeep_4x4.jpg', '', 'figurine', 1, 80, 1785801600000, 1785801600000),

('2a8ee4de-3ae9-4441-9a27-c61e987a29de', 'temple-gopuram-two-tone',
 'Temple Gopuram — Two-Tone',
 'South Indian gopuram with tiered sculpted stories, printed in orange over a brown stone-effect base.',
 89900, 'assets/images/IMG20260521_temple1.jpg', '', 'decor', 1, 90, 1785801600000, 1785801600000),

('a75cc81f-f801-4021-9ed0-f21caf0390b2', 'temple-gopuram-gold',
 'Temple Gopuram — Gold',
 'Compact gopuram in a single gold filament, with the same tiered relief detail.',
 89900, 'assets/images/IMG20260521_temple2.jpg', '', 'decor', 1, 100, 1785801600000, 1785801600000),

('4c4ce5f0-dd32-4f3c-bf20-77f794633cca', 'wall-staircase-shelf',
 'Wall-Mounted Staircase Shelf',
 'Floating staircase shelf for wall mounting — decorative and usable.',
 89900, 'assets/images/IMG20260729_wall_staircase.jpg', '', 'functional', 1, 110, 1785801600000, 1785801600000),

-- ── multi-piece sets · ₹1299 ──────────────────────────────────────
('b7f44af9-c8b9-4c21-beea-422bfece47a7', 'carved-vase-pair',
 'Carved Relief Vase Pair',
 'Two tall vases with deep carved relief — lotus and peacock on one, dragon and cloud on the other. Wood-effect gradient filament.',
 129900, 'assets/images/IMG20260521_vases_temple.jpg', '', 'set', 1, 120, 1785801600000, 1785801600000),

('433e170e-c567-4482-827f-8b67eed8314e', 'dahlia-bouquet-vase',
 'Dahlia Bouquet with Vase',
 'Around nine printed dahlia blooms arranged in a matching spiral-ribbed vase.',
 129900, 'assets/images/IMG20260725_flowers_bouquet.jpg', '', 'set', 1, 130, 1785801600000, 1785801600000),

('e6d0261c-dc6a-4ffb-8cf5-2b8eac91985f', 'dogs-rooster-set',
 'Dogs & Rooster Set',
 'A group of animal figurines printed as a matching set.',
 129900, 'assets/images/IMG20260521_dogs_rooster.jpg', '', 'set', 1, 140, 1785801600000, 1785801600000),

-- ── mid figurines · ₹549 ──────────────────────────────────────────
('d6d8f543-3de6-43c5-bf7e-da8c3e592e88', 'golden-vase',
 'Golden Vase',
 'Slim decorative vase in metallic gold filament.',
 54900, 'assets/images/IMG20260517_golden_vase.jpg', '', 'decor', 1, 150, 1785801600000, 1785801600000),

('1d84c4d7-045e-43db-beaa-2f72f53e006f', 'dahlia-flowers',
 'Dahlia Flowers — Set of Three',
 'Three printed dahlia stems, sold without a vase.',
 54900, 'assets/images/IMG20260725_dahlias.jpg', '', 'decor', 1, 160, 1785801600000, 1785801600000),

('044d5b78-4a84-493e-985a-6eb493b8d72c', 'laughing-buddha',
 'Laughing Buddha',
 'Seated laughing Buddha holding a coin, in metallic gold with flowing robe detail.',
 54900, 'assets/images/IMG20260531_laughing_buddha.jpg', '', 'figurine', 1, 170, 1785801600000, 1785801600000),

('ab4dd9eb-92c2-4dca-8213-6da7ba80bf80', 'praying-baby-buddha',
 'Praying Baby Buddha',
 'Small seated Buddha with hands together, printed in bright orange.',
 54900, 'assets/images/IMG20260521_buddha_icecream.jpg', '', 'figurine', 1, 180, 1785801600000, 1785801600000),

('23ac4372-9447-4a9f-8960-b6c043b345a7', 'red-horse',
 'Red Horse',
 'Stylised standing horse in deep red filament.',
 54900, 'assets/images/IMG20260517_red_horse.jpg', '', 'figurine', 1, 190, 1785801600000, 1785801600000),

('87586f51-9aef-4816-bc11-42cd212a4ca7', 'phone-stand-figure',
 'Figure Phone Stand',
 'Sculpted figure that doubles as a desk phone stand.',
 54900, 'assets/images/IMG20260531_phone_stand_figure.jpg', '', 'functional', 1, 200, 1785801600000, 1785801600000),

-- ── small figurines · ₹349 ────────────────────────────────────────
('ee7d1619-2a75-4cf1-9245-4ed934d56656', 'kingfisher-figurine',
 'Kingfisher',
 'Multi-colour kingfisher with teal plumage, black bill and orange feet — printed with filament changes, not painted.',
 34900, 'assets/images/IMG20260725_kingfisher.jpg', '', 'figurine', 1, 210, 1785801600000, 1785801600000),

('8433d3c0-cd02-4915-b027-1f0070eada6e', 'white-stork-figurine',
 'White Stork',
 'Standing stork figurine in white filament.',
 34900, 'assets/images/IMG20260725_stork.jpg', '', 'figurine', 1, 220, 1785801600000, 1785801600000),

('2d7c40aa-e6fc-472f-a9af-96a8c9e3186d', 'bird-on-blossom-branch',
 'Bird on Blossom Branch',
 'Songbird perched on a flowering branch base, printed as one piece in coral orange.',
 34900, 'assets/images/IMG20260521_bird.jpg', '', 'decor', 1, 230, 1785801600000, 1785801600000),

('0274fc25-173e-4d98-9aa1-2c047ae7a2d0', 'moon-swing-figurine',
 'Girl on a Moon Swing',
 'Figure swinging from a crescent moon on a rope, on a rocky plinth. Fine, delicate print in white.',
 34900, 'assets/images/IMG20260215094926.jpg', '', 'figurine', 1, 240, 1785801600000, 1785801600000),

('ae49b955-a5bf-4f4b-b0db-15c945721bcb', 'butterfly-hand',
 'Butterfly Hand',
 'Open hand with a butterfly resting on it — a small decorative piece.',
 34900, 'assets/images/IMG20260517_butterfly_hand.jpg', '', 'decor', 1, 250, 1785801600000, 1785801600000),

('655f2b31-0613-4a3e-b7a3-a474b4a4a062', 'ice-cream-cone',
 'Soft-Serve Ice Cream Cone',
 'Oversized novelty ice cream cone — white swirl on a waffle-textured orange cone.',
 34900, 'assets/images/IMG20260521_icecream_cone.jpg', '', 'decor', 1, 260, 1785801600000, 1785801600000),

-- ── licensed characters · seeded HIDDEN (visible = 0) ─────────────
-- These depict third-party IP. They remain in the gallery as portfolio work;
-- listing them for sale is a separate decision. See the note at the top.
('b545d08c-0172-497a-9215-3f0bbe1ef4c3', 'spiderman-figurine',
 'Spider-Man Figurine',
 'Character figurine. LICENSED IP (Marvel) — hidden from the shop pending a decision on selling it.',
 54900, 'assets/images/IMG20260517_spiderman.jpg', '', 'figurine', 0, 270, 1785801600000, 1785801600000),

('f2d62e3e-7536-4a06-82ea-312ea1aa558c', 'batman-angel-set',
 'Batman & Angel Set',
 'Paired figurines, shown with a printed Eiffel Tower. LICENSED IP (DC) — hidden from the shop pending a decision on selling it.',
 129900, 'assets/images/IMG20260725_batman_angel.jpg',
 'assets/images/IMG20260725_batman_angel_topdown.jpg,assets/images/IMG20260725_batman_angel_eiffel.jpg',
 'set', 0, 280, 1785801600000, 1785801600000),

('d9655559-d3c4-4f93-98b2-a16c1e1c1e69', 'tinkerbell-figurine',
 'Tinkerbell Figurine',
 'Character figurine. LICENSED IP (Disney) — hidden from the shop pending a decision on selling it.',
 34900, 'assets/images/IMG20260413121025.jpg', '', 'figurine', 0, 290, 1785801600000, 1785801600000),

('e9034796-ddc6-46d8-a4d3-31ddd76fa8a9', 'carebear-figurine',
 'Good Luck Care Bear',
 'Character figurine. LICENSED IP (Cloudco) — hidden from the shop pending a decision on selling it.',
 54900, 'assets/images/IMG20260725_carebear.jpg', '', 'figurine', 0, 300, 1785801600000, 1785801600000),

('99fd322b-ba1f-4cd7-855c-6e3a500e7fd9', 'tbm900-aircraft',
 'TBM 900 Aircraft Model',
 'Scale aircraft model. Reproduces Daher trade dress — hidden from the shop pending a decision on selling it.',
 89900, 'assets/images/IMG20260725_tbm900_plane.jpg', '', 'figurine', 0, 310, 1785801600000, 1785801600000);
