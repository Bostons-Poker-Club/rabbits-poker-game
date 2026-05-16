-- Monthly fees: add payment tracking, suspension, and reminder columns
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS payment_method   TEXT;
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS payment_notes    TEXT;
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS fee_suspended    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS reminder_25_sent_at TIMESTAMPTZ;
ALTER TABLE monthly_fees ADD COLUMN IF NOT EXISTS reminder_1_sent_at  TIMESTAMPTZ;

-- Add fee suspension flag to users so auth middleware can enforce it
ALTER TABLE users ADD COLUMN IF NOT EXISTS fee_suspended BOOLEAN NOT NULL DEFAULT FALSE;

-- Payment history: one row per payment, used for total fee income reporting
CREATE TABLE IF NOT EXISTS monthly_fee_payments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username       VARCHAR(50),
  role_type      VARCHAR(10),
  amount         INTEGER     NOT NULL,
  for_month      DATE        NOT NULL,
  payment_method TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfp_user_id    ON monthly_fee_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_mfp_created_at ON monthly_fee_payments(created_at);
