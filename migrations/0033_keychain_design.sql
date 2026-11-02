-- 0033_keychain_design.sql — remember WHICH custom keychain design an order line is
--
-- A custom name keychain line (src/keychain.js) already carries a readable
-- summary in `personalisation` ('"PRIYA" · Script font · Blue base, Gold text').
-- That is for people. To build the print file (src/kc3mf.js) the shop needs the
-- design itself — the exact text, font key and colour keys — so the line keeps
-- its design id too: the same kc~… string the cart used, validated again by
-- parseDesign() whenever it is read. Empty for every other line.
ALTER TABLE order_items ADD COLUMN design_id TEXT NOT NULL DEFAULT '';
