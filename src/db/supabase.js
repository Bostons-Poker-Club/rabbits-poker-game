'use strict';

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'placeholder';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'placeholder';

if (!process.env.SUPABASE_URL) {
  console.warn('⚠️  SUPABASE_URL not set — DB features disabled, local admin only');
}
console.log('[supabase] URL:', supabaseUrl.slice(0, 40));
console.log('[supabase] SERVICE_KEY set:', !!process.env.SUPABASE_SERVICE_KEY, '| prefix:', supabaseServiceKey.slice(0, 12));
console.log('[supabase] ANON_KEY set:', !!process.env.SUPABASE_ANON_KEY, '| prefix:', supabaseAnonKey.slice(0, 12));

// Service client for server-side operations (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Anon client for public operations
const supabase = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = { supabase, supabaseAdmin };
