-- Migration 013: Host chip budget tracking
-- Run in Supabase SQL editor

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS host_chip_budget  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS host_chips_used   INTEGER NOT NULL DEFAULT 0;

-- host_chip_budget = 0 means unlimited (admin/super-admin)
-- host_chips_used  = running total reset manually by admin

COMMENT ON COLUMN users.host_chip_budget IS '0 = unlimited. Max chips host can give out per cycle.';
COMMENT ON COLUMN users.host_chips_used  IS 'Total chips given out since last admin reset.';
