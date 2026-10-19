-- The reviewer's email, MASKED, for reviews posted while signed in (2026-10-19).
-- Only the masked form is stored ("vr*****8@gmail.com"), taken from the
-- signed-in account at the moment of posting — never typed, never the full
-- address. Empty for guests and for owner-added reviews.
ALTER TABLE reviews ADD COLUMN email_masked TEXT NOT NULL DEFAULT '';
