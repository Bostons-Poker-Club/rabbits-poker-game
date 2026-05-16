-- Login audit log: tracks every login attempt (success and failure)
CREATE TABLE IF NOT EXISTS login_audit (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  username       VARCHAR(50) NOT NULL,
  ip_address     VARCHAR(45) NOT NULL,
  user_agent     TEXT,
  success        BOOLEAN     NOT NULL DEFAULT FALSE,
  failure_reason VARCHAR(100),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_audit_user_id    ON login_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_login_audit_username   ON login_audit(username);
CREATE INDEX IF NOT EXISTS idx_login_audit_ip_address ON login_audit(ip_address);
CREATE INDEX IF NOT EXISTS idx_login_audit_created_at ON login_audit(created_at DESC);
