-- Run in Supabase SQL Editor
-- Adds host applications, rake splits, monthly fee tracking, and persists host status

-- Persist host status on users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_host   BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS host_type VARCHAR(10); -- 'host' or 'admin'

-- Track which host/admin created each table (for rake split attribution)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES users(id);

-- Host applications (submitted before account creation; admin approves)
CREATE TABLE IF NOT EXISTS host_applications (
  id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name             VARCHAR(120) NOT NULL,
  phone                 VARCHAR(20)  NOT NULL,
  email                 VARCHAR(255) NOT NULL,
  address               TEXT         NOT NULL,
  government_id_data    TEXT         NOT NULL,  -- base64 data URL
  government_id_filename VARCHAR(255),
  monthly_fee_agreed    BOOLEAN      NOT NULL DEFAULT FALSE,
  rake_agreed           BOOLEAN      NOT NULL DEFAULT FALSE,
  status                VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  notes                 TEXT,
  user_id               UUID         REFERENCES users(id),        -- set when approved
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           UUID         REFERENCES users(id)
);

-- Rake splits recorded each time a table session closes
CREATE TABLE IF NOT EXISTS table_rake_splits (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id      UUID,                             -- may be null if table deleted
  table_name    VARCHAR(100),
  session_date  DATE         NOT NULL DEFAULT CURRENT_DATE,
  total_rake    INTEGER      NOT NULL DEFAULT 0,
  host_id       UUID         REFERENCES users(id),
  host_username VARCHAR(50),
  host_type     VARCHAR(10),                       -- 'host' or 'admin'
  host_percent  NUMERIC(4,2) NOT NULL DEFAULT 0,
  host_amount   INTEGER      NOT NULL DEFAULT 0,
  house_amount  INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Monthly fee tracking ($20 hosts, $40 admins)
CREATE TABLE IF NOT EXISTS monthly_fees (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID         NOT NULL REFERENCES users(id) UNIQUE,
  username      VARCHAR(50),
  role_type     VARCHAR(10)  NOT NULL,   -- 'host' or 'admin'
  fee_amount    INTEGER      NOT NULL,   -- 20 for host, 40 for admin (dollars)
  last_paid_at  TIMESTAMPTZ,
  next_due_date DATE,
  is_overdue    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_host_applications_status ON host_applications(status);
CREATE INDEX IF NOT EXISTS idx_rake_splits_host_id      ON table_rake_splits(host_id);
CREATE INDEX IF NOT EXISTS idx_monthly_fees_user_id     ON monthly_fees(user_id);
