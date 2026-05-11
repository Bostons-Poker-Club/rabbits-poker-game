-- RabbsRoom — Player profile fields migration
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name  TEXT,
  ADD COLUMN IF NOT EXISTS nickname   TEXT,
  ADD COLUMN IF NOT EXISTS phone      TEXT,
  ADD COLUMN IF NOT EXISTS address    TEXT,
  ADD COLUMN IF NOT EXISTS city       TEXT,
  ADD COLUMN IF NOT EXISTS state      TEXT,
  ADD COLUMN IF NOT EXISTS zip        TEXT;
