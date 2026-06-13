'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function _create(label, sql) {
  try {
    await pool.query(sql);
    console.log(`[db] OK: ${label}`);
  } catch (err) {
    console.error(`[db] FAIL: ${label} —`, err.message);
  }
}

async function runMigrations() {
  console.log('[db] Running migrations...');

  await _create('users', `
    CREATE TABLE IF NOT EXISTS users (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username                TEXT UNIQUE NOT NULL,
      email                   TEXT,
      password_hash           TEXT NOT NULL,
      chips                   INTEGER NOT NULL DEFAULT 0,
      is_admin                BOOLEAN NOT NULL DEFAULT FALSE,
      is_host                 BOOLEAN NOT NULL DEFAULT FALSE,
      is_banned               BOOLEAN NOT NULL DEFAULT FALSE,
      banned_at               TIMESTAMPTZ,
      ban_reason              TEXT,
      fee_suspended           BOOLEAN NOT NULL DEFAULT FALSE,
      avatar_url              TEXT,
      nickname                TEXT,
      full_name               TEXT,
      phone                   TEXT,
      address                 TEXT,
      city                    TEXT,
      state                   TEXT,
      zip                     TEXT,
      role                    TEXT,
      host_type               TEXT,
      host_chip_budget        INTEGER DEFAULT 0,
      host_chips_used         INTEGER DEFAULT 0,
      two_fa_enabled          BOOLEAN DEFAULT TRUE,
      two_fa_locked_until     TIMESTAMPTZ,
      two_fa_backup_codes     JSONB DEFAULT '[]',
      two_fa_trusted_devices  JSONB DEFAULT '[]',
      must_change_password    BOOLEAN DEFAULT FALSE,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('tables', `
    CREATE TABLE IF NOT EXISTS tables (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name                TEXT NOT NULL,
      game_type           TEXT NOT NULL DEFAULT 'holdem',
      stakes_small_blind  INTEGER NOT NULL DEFAULT 1,
      stakes_big_blind    INTEGER NOT NULL DEFAULT 2,
      max_players         INTEGER NOT NULL DEFAULT 9,
      rake_percent        INTEGER NOT NULL DEFAULT 5,
      host_id             UUID REFERENCES users(id) ON DELETE SET NULL,
      felt_color          TEXT DEFAULT '#1a5c2a',
      status              TEXT NOT NULL DEFAULT 'active',
      created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('table_seats', `
    CREATE TABLE IF NOT EXISTS table_seats (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id        UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seat_number     INTEGER NOT NULL,
      chips_on_table  INTEGER NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(table_id, user_id)
    )
  `);

  await _create('hands', `
    CREATE TABLE IF NOT EXISTS hands (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id              UUID REFERENCES tables(id) ON DELETE SET NULL,
      rake_collected        INTEGER NOT NULL DEFAULT 0,
      jackpot_contribution  INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'completed',
      started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('hand_actions', `
    CREATE TABLE IF NOT EXISTS hand_actions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hand_id     UUID REFERENCES hands(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      username    TEXT,
      action      TEXT NOT NULL,
      amount      INTEGER NOT NULL DEFAULT 0,
      round       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Drop jackpot only if it still has the old UUID id column — one-time schema fix
  await _create('jackpot (drop if wrong type)', `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'jackpot' AND column_name = 'id' AND data_type = 'uuid'
      ) THEN
        DROP TABLE IF EXISTS jackpot CASCADE;
      END IF;
    END $$
  `);
  await _create('jackpot', `
    CREATE TABLE IF NOT EXISTS jackpot (
      id                    INTEGER PRIMARY KEY,
      current_amount        INTEGER NOT NULL DEFAULT 0,
      last_awarded_at       TIMESTAMPTZ,
      timer_started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      highest_hand_rank     INTEGER NOT NULL DEFAULT -1,
      highest_hand_user_id  UUID
    )
  `);

  await _create('tournaments', `
    CREATE TABLE IF NOT EXISTS tournaments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name            TEXT NOT NULL,
      buy_in          INTEGER NOT NULL DEFAULT 0,
      starting_chips  INTEGER NOT NULL DEFAULT 1000,
      blind_schedule  JSONB DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'registering',
      started_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('tournament_players', `
    CREATE TABLE IF NOT EXISTS tournament_players (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tournament_id   UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chips           INTEGER NOT NULL DEFAULT 0,
      placement       INTEGER,
      is_eliminated   BOOLEAN NOT NULL DEFAULT FALSE,
      buy_in_paid     BOOLEAN NOT NULL DEFAULT FALSE,
      prize_won       INTEGER DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'registered',
      registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tournament_id, user_id)
    )
  `);

  await _create('transactions', `
    CREATE TABLE IF NOT EXISTS transactions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      username        TEXT,
      type            TEXT NOT NULL,
      amount          INTEGER NOT NULL DEFAULT 0,
      table_name      TEXT,
      payment_method  TEXT,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('session_reports', `
    CREATE TABLE IF NOT EXISTS session_reports (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id        UUID REFERENCES tables(id) ON DELETE SET NULL,
      table_name      TEXT,
      game_type       TEXT,
      total_rake      INTEGER NOT NULL DEFAULT 0,
      pot_volume      INTEGER NOT NULL DEFAULT 0,
      hands_played    INTEGER NOT NULL DEFAULT 0,
      host_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      host_username   TEXT,
      host_type       TEXT,
      host_percent    INTEGER NOT NULL DEFAULT 0,
      host_amount     INTEGER NOT NULL DEFAULT 0,
      house_amount    INTEGER NOT NULL DEFAULT 0,
      hands_detail    JSONB DEFAULT '[]',
      session_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('monthly_fees', `
    CREATE TABLE IF NOT EXISTS monthly_fees (
      user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username            TEXT NOT NULL,
      role_type           TEXT NOT NULL,
      fee_amount          INTEGER NOT NULL DEFAULT 0,
      next_due_date       DATE,
      is_overdue          BOOLEAN NOT NULL DEFAULT FALSE,
      fee_suspended       BOOLEAN NOT NULL DEFAULT FALSE,
      suspended_at        TIMESTAMPTZ,
      last_paid_at        TIMESTAMPTZ,
      reminder_25_sent_at TIMESTAMPTZ,
      reminder_1_sent_at  TIMESTAMPTZ,
      payment_method      TEXT,
      payment_notes       TEXT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('monthly_fee_payments', `
    CREATE TABLE IF NOT EXISTS monthly_fee_payments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      username        TEXT NOT NULL,
      role_type       TEXT NOT NULL,
      amount          INTEGER NOT NULL DEFAULT 0,
      for_month       DATE,
      payment_method  TEXT,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('player_notes', `
    CREATE TABLE IF NOT EXISTS player_notes (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
      author_username TEXT NOT NULL,
      note            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('player_stats', `
    CREATE TABLE IF NOT EXISTS player_stats (
      user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username        TEXT NOT NULL,
      hands_played    INTEGER NOT NULL DEFAULT 0,
      hands_won       INTEGER NOT NULL DEFAULT 0,
      total_won       INTEGER NOT NULL DEFAULT 0,
      biggest_pot     INTEGER NOT NULL DEFAULT 0,
      sessions_played INTEGER NOT NULL DEFAULT 0,
      favorite_hand   TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('messages', `
    CREATE TABLE IF NOT EXISTS messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      from_username   TEXT NOT NULL,
      message         TEXT NOT NULL,
      target_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
      target_all      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('login_audit', `
    CREATE TABLE IF NOT EXISTS login_audit (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      username        TEXT NOT NULL,
      ip_address      TEXT,
      user_agent      TEXT,
      success         BOOLEAN NOT NULL DEFAULT FALSE,
      failure_reason  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('table_waitlist', `
    CREATE TABLE IF NOT EXISTS table_waitlist (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id    UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(table_id, user_id)
    )
  `);

  await _create('highlights', `
    CREATE TABLE IF NOT EXISTS highlights (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT,
      video_url   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await _create('highlight_likes', `
    CREATE TABLE IF NOT EXISTS highlight_likes (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      highlight_id    UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(highlight_id, user_id)
    )
  `);

  await _create('highlight_comments', `
    CREATE TABLE IF NOT EXISTS highlight_comments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      highlight_id    UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comment         TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed jackpot singleton row
  await _create('jackpot seed', `
    INSERT INTO jackpot (id, current_amount, highest_hand_rank)
    VALUES (1, 0, -1)
    ON CONFLICT DO NOTHING
  `);

  // Seed admin account on first run
  await _create('admin seed', `
    INSERT INTO users (username, email, password_hash, chips, is_admin)
    VALUES ('rabbsroom', 'bostonspokerclub.amitureflops@gmail.com',
            '$2a$10$XZ/Q7fZYZQ9jb7IVp37Pru/PMr6EHZmo52QhDb/fr7DrNNMTf71Z.', 999999, TRUE)
    ON CONFLICT (username) DO NOTHING
  `);

  console.log('[db] Migrations complete');
}

module.exports = pool;
module.exports.runMigrations = runMigrations;
