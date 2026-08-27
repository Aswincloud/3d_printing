-- 0018_personalisation.sql — ask for what to print, before payment
--
-- Three live products ask the buyer for something the shop never collected:
-- Business Cards ("your name, company and contact details"), Plate Keychains
-- ("any name, car model, or text") and the PS5 stand ("any colour on request").
-- Checkout had one optional order-level Notes box and nothing per item, so an
-- order could be paid in full with no idea what to put on the print.
--
-- ONE COLUMN DECIDES BOTH QUESTIONS. An empty personalise_label means "this
-- product does not ask"; a non-empty one is both the flag and the wording shown
-- to the customer. Two columns — a boolean and a label — could disagree, and the
-- failure mode of that disagreement is a field with no prompt or a prompt with
-- no field.
--
-- Required is genuinely separate. The PS5 stand has a default colour and the
-- question is an upsell; a keychain with no name is not a product. Same column
-- shape, opposite answer.
ALTER TABLE products ADD COLUMN personalise_label    TEXT    NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN personalise_required INTEGER NOT NULL DEFAULT 0;

-- The server-side cart, so a value survives signing in on another device. Same
-- reasoning as the qty column beside it: the cart holds intent, not price.
ALTER TABLE cart_items ADD COLUMN personalisation TEXT NOT NULL DEFAULT '';

-- A SNAPSHOT, exactly like name and price_paise beside it. Editing a product's
-- label later must not rewrite what somebody already ordered — the same reason
-- order_items does not join to products for its name.
ALTER TABLE order_items ADD COLUMN personalisation TEXT NOT NULL DEFAULT '';

-- Seed the three that prompted this. By slug, not id: ids are uuids generated at
-- insert and differ between local and remote, so an id here would apply cleanly
-- to one database and silently match nothing in the other.
UPDATE products
   SET personalise_label = 'Name, company and contact details to print',
       personalise_required = 1
 WHERE slug = 'business-cards';

UPDATE products
   SET personalise_label = 'Name or text to print',
       personalise_required = 1
 WHERE slug = 'plate-keychains';

-- Optional: it ships in pale blue unless asked otherwise, so a blank answer is a
-- real answer here and must not block checkout.
UPDATE products
   SET personalise_label = 'Colour',
       personalise_required = 0
 WHERE slug = 'ps5-horizontal-stand';
