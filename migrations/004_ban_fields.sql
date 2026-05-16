-- Run in Supabase SQL Editor
-- Adds ban_reason and banned_at columns to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned) WHERE is_banned = TRUE;
