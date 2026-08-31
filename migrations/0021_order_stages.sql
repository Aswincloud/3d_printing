-- The stages between "paid" and "shipped".
--
-- An order used to go paid -> shipped, so every day the print was actually being
-- made was invisible to the customer. These carry the timestamps for the new
-- in_production / ready / delivered stages.
--
-- Three columns rather than an order_events table: there are six fixed stages
-- and they need six timestamps, and `paid_at` / `shipped_at` already establish
-- exactly this pattern on the same row.
--
-- All nullable, and NOT backfilled. Orders placed before this have a shipped_at
-- and nulls in the middle; the tracker treats a stage as done when a LATER stage
-- has a timestamp, which is what makes those rows render sensibly.
ALTER TABLE orders ADD COLUMN production_at INTEGER;
ALTER TABLE orders ADD COLUMN ready_at      INTEGER;
ALTER TABLE orders ADD COLUMN delivered_at  INTEGER;
