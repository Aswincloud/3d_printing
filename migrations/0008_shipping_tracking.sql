-- 0008_shipping_tracking.sql — courier and tracking number on an order
--
-- Marking an order shipped previously changed a status column and told the
-- customer nothing, even though the confirmation email promises "I'll email you
-- again when it ships". These columns carry what that email needs.
--
-- Stored rather than passed straight into the email and discarded: the tracking
-- number is the thing a customer asks about a week later ("where is my parcel?"),
-- and it has to be findable in the dashboard then, not only in an email that was
-- sent once.
--
-- Both nullable. A print handed to a local courier with no tracking number is
-- still shipped, and blocking the transition on data that may not exist would
-- mean either lying in the field or not marking it shipped at all.
ALTER TABLE orders ADD COLUMN courier TEXT;
ALTER TABLE orders ADD COLUMN tracking_id TEXT;
