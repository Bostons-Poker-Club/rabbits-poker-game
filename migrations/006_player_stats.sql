-- Run in Supabase SQL Editor
-- Player statistics and leaderboard table

CREATE TABLE IF NOT EXISTS player_stats (
  user_id          UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username         VARCHAR(50)  NOT NULL DEFAULT '',
  hands_played     INTEGER      NOT NULL DEFAULT 0,
  hands_won        INTEGER      NOT NULL DEFAULT 0,
  total_won        INTEGER      NOT NULL DEFAULT 0,
  total_lost       INTEGER      NOT NULL DEFAULT 0,
  biggest_pot      INTEGER      NOT NULL DEFAULT 0,
  favorite_hand    VARCHAR(30),
  sessions_played  INTEGER      NOT NULL DEFAULT 0,
  last_hand_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_stats_total_won     ON player_stats(total_won DESC);
CREATE INDEX IF NOT EXISTS idx_player_stats_biggest_pot   ON player_stats(biggest_pot DESC);
CREATE INDEX IF NOT EXISTS idx_player_stats_sessions      ON player_stats(sessions_played DESC);
CREATE INDEX IF NOT EXISTS idx_player_stats_hands_played  ON player_stats(hands_played DESC);
