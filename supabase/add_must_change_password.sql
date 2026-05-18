-- Add must_change_password column to users table
-- Run this in Supabase SQL editor before deploying the password reset feature
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean DEFAULT false;
