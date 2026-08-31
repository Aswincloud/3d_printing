-- Pin a product to the top of the catalogue.
--
-- Deliberately NOT an overload of `sort`. The two answer different questions:
-- `sort` is the standing house order (curated in steps of 10), `pinned` is
-- "lead the shop, now". Overloading would also need negative sort values, and
-- updateProduct() validates sort with parsePaise(), which rejects them.
--
-- No index: this table has 85 rows.
ALTER TABLE products ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
