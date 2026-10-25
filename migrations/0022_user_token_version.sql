-- 2026-10-26: logout, a password change and an admin reset revoke the user's
-- sessions. The JWT carries the version it was issued at (`tv`); loadUser
-- only accepts a token whose tv matches, so bumping it ends every older session.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
