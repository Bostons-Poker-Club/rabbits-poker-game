-- Two-Factor Authentication for admin and host accounts
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled         BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_locked_until    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_backup_codes    JSONB       NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_trusted_devices JSONB       NOT NULL DEFAULT '[]'::jsonb;
