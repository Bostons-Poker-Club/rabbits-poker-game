-- Safe migrations for optional user profile columns
-- Run this in Supabase SQL editor once. All statements are idempotent (IF NOT EXISTS).

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url           text    DEFAULT null;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_host              boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned            boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname             text    DEFAULT null;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name            text    DEFAULT null;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone                text    DEFAULT null;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled       boolean DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_locked_until  timestamptz DEFAULT null;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_trusted_devices jsonb DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_backup_codes  jsonb  DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fee_suspended        boolean DEFAULT false;
