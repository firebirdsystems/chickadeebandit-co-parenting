-- Intentionally empty.
--
-- This version added pairing-session and read-receipt columns to the app's own
-- message table. That table no longer exists in this app's schema: the
-- parents' conversation is the space's Messages, kept by the hub. The file
-- stays so the versions after it keep their numbers.
SELECT 1;
