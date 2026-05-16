-- Add game_type to session_reports so reports show the game variant played

ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS game_type VARCHAR(10) DEFAULT 'holdem';
