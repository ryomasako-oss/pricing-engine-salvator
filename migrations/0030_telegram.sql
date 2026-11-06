-- Silvy on Telegram (server/worker/routes/telegram.ts): the Telegram account a
-- user linked by sharing their own phone number, and that chat's history.
ALTER TABLE users ADD COLUMN telegram_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_chats (
  telegram_id INTEGER PRIMARY KEY,
  messages    TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
