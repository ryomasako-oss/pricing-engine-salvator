-- Silvy on Telegram: a Telegram number apart from the WhatsApp one (users.phone),
-- for people whose Telegram account is on another number. Empty = use phone.
ALTER TABLE users ADD COLUMN telegram_phone TEXT NOT NULL DEFAULT '';
