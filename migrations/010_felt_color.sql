-- Add felt color to tables
ALTER TABLE tables ADD COLUMN IF NOT EXISTS felt_color VARCHAR(20) NOT NULL DEFAULT '#1a5c2a';
