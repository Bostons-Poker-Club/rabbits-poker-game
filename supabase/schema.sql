-- Rabbits Poker Game - Supabase Schema
-- Run this SQL in the Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  chips INTEGER NOT NULL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tables table
CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  game_type VARCHAR(20) NOT NULL DEFAULT 'holdem' CHECK (game_type IN ('holdem', 'plo')),
  stakes_small_blind INTEGER NOT NULL DEFAULT 5,
  stakes_big_blind INTEGER NOT NULL DEFAULT 10,
  max_players INTEGER NOT NULL DEFAULT 9 CHECK (max_players BETWEEN 2 AND 9),
  status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
  rake_percent NUMERIC(4,2) NOT NULL DEFAULT 5.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table seats
CREATE TABLE IF NOT EXISTS table_seats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND 9),
  chips_on_table INTEGER NOT NULL DEFAULT 0,
  is_sitting_out BOOLEAN NOT NULL DEFAULT FALSE,
  break_passes_used INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(table_id, seat_number),
  UNIQUE(table_id, user_id)
);

-- Hands table
CREATE TABLE IF NOT EXISTS hands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  hand_number INTEGER NOT NULL DEFAULT 1,
  dealer_seat INTEGER,
  community_cards JSONB DEFAULT '[]',
  pot INTEGER NOT NULL DEFAULT 0,
  rake_collected INTEGER NOT NULL DEFAULT 0,
  jackpot_contribution INTEGER NOT NULL DEFAULT 0,
  winner_id UUID REFERENCES users(id),
  best_hand_rank INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- Hand actions
CREATE TABLE IF NOT EXISTS hand_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hand_id UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('fold', 'check', 'call', 'raise', 'bet', 'all_in', 'blind')),
  amount INTEGER NOT NULL DEFAULT 0,
  betting_round VARCHAR(20) NOT NULL CHECK (betting_round IN ('preflop', 'flop', 'turn', 'river')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Jackpot table (single row)
CREATE TABLE IF NOT EXISTS jackpot (
  id INTEGER PRIMARY KEY DEFAULT 1,
  current_amount INTEGER NOT NULL DEFAULT 0,
  last_awarded_at TIMESTAMPTZ,
  last_awarded_to UUID REFERENCES users(id),
  timer_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  highest_hand_rank INTEGER NOT NULL DEFAULT -1,
  highest_hand_user_id UUID REFERENCES users(id)
);

-- Insert initial jackpot row
INSERT INTO jackpot (id, current_amount, timer_started_at, highest_hand_rank)
VALUES (1, 0, NOW(), -1)
ON CONFLICT (id) DO NOTHING;

-- Tournaments table
CREATE TABLE IF NOT EXISTS tournaments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  buy_in INTEGER NOT NULL DEFAULT 100,
  starting_chips INTEGER NOT NULL DEFAULT 10000,
  status VARCHAR(20) NOT NULL DEFAULT 'registering' CHECK (status IN ('registering', 'active', 'completed')),
  blind_schedule JSONB NOT NULL DEFAULT '[
    {"level": 1, "small_blind": 25, "big_blind": 50, "duration_minutes": 15},
    {"level": 2, "small_blind": 50, "big_blind": 100, "duration_minutes": 15},
    {"level": 3, "small_blind": 75, "big_blind": 150, "duration_minutes": 15},
    {"level": 4, "small_blind": 100, "big_blind": 200, "duration_minutes": 15},
    {"level": 5, "small_blind": 150, "big_blind": 300, "duration_minutes": 15},
    {"level": 6, "small_blind": 200, "big_blind": 400, "duration_minutes": 15},
    {"level": 7, "small_blind": 300, "big_blind": 600, "duration_minutes": 15},
    {"level": 8, "small_blind": 500, "big_blind": 1000, "duration_minutes": 15}
  ]',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tournament players
CREATE TABLE IF NOT EXISTS tournament_players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chips INTEGER NOT NULL DEFAULT 0,
  placement INTEGER,
  is_eliminated BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_table_seats_table_id ON table_seats(table_id);
CREATE INDEX IF NOT EXISTS idx_table_seats_user_id ON table_seats(user_id);
CREATE INDEX IF NOT EXISTS idx_hands_table_id ON hands(table_id);
CREATE INDEX IF NOT EXISTS idx_hand_actions_hand_id ON hand_actions(hand_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament_id ON tournament_players(tournament_id);

-- Row Level Security (optional - disable for server-side access with service key)
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tables ENABLE ROW LEVEL SECURITY;

-- Create default admin user (password: admin123 - CHANGE THIS)
-- Password hash for 'admin123': $2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
INSERT INTO users (username, email, password_hash, chips, is_admin)
VALUES ('admin', 'admin@rabbitspoker.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 999999, TRUE)
ON CONFLICT (username) DO NOTHING;
