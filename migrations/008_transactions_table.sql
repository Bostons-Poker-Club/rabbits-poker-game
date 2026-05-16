-- Transactions table for buy-in / cash-out / rake-contribution history
CREATE TABLE IF NOT EXISTS transactions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  username       VARCHAR(50),
  type           VARCHAR(30) NOT NULL,   -- 'buy_in', 'cash_out', 'rake', 'fee_payment', etc.
  amount         INTEGER     NOT NULL DEFAULT 0,
  table_name     VARCHAR(100),
  payment_method VARCHAR(50),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type       ON transactions(type);
