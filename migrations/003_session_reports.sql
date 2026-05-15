-- Run in Supabase SQL Editor
-- Adds session_reports table for end-of-session rake report storage

CREATE TABLE IF NOT EXISTS session_reports (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id      UUID,
  table_name    VARCHAR(100) NOT NULL,
  session_date  DATE         NOT NULL DEFAULT CURRENT_DATE,
  total_rake    INTEGER      NOT NULL DEFAULT 0,
  pot_volume    INTEGER      NOT NULL DEFAULT 0,
  hands_played  INTEGER      NOT NULL DEFAULT 0,
  host_id       UUID         REFERENCES users(id),
  host_username VARCHAR(50),
  host_type     VARCHAR(10),
  host_percent  NUMERIC(4,2) NOT NULL DEFAULT 0,
  host_amount   INTEGER      NOT NULL DEFAULT 0,
  house_amount  INTEGER      NOT NULL DEFAULT 0,
  hands_detail  JSONB        NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_reports_created_at ON session_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_reports_table_id   ON session_reports(table_id);
