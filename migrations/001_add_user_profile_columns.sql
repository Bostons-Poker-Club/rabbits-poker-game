-- Run this once in the Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)
-- Adds extended profile columns to the users table.

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS zip       TEXT;
