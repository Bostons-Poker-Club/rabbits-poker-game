-- Private admin/host notes on players
CREATE TABLE IF NOT EXISTS player_notes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  author_username VARCHAR(50) NOT NULL,
  note         TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_notes_player ON player_notes(player_id);
CREATE INDEX IF NOT EXISTS idx_player_notes_author  ON player_notes(author_id);
