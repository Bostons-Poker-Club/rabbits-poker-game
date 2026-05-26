-- Migration 013: Add buy_in_paid, prize_won, status to tournament_players
-- Also adds max_players to tournaments table for capacity tracking

ALTER TABLE tournament_players
  ADD COLUMN IF NOT EXISTS buy_in_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prize_won   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status      VARCHAR(20) NOT NULL DEFAULT 'registered';
-- status values: 'registered' | 'active' | 'eliminated' | 'winner'

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS max_players INTEGER NOT NULL DEFAULT 100;

-- Index for fast player roster lookups
CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament_id
  ON tournament_players(tournament_id);
