'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Local admin fallback — works without Supabase
const LOCAL_ADMIN = {
  id: 'local-admin-000',
  username: process.env.ADMIN_USERNAME || 'admin',
  email: 'admin@rabbitspoker.com',
  passwordHash: process.env.ADMIN_PASSWORD_HASH || '$2a$10$yYkfV4Gbu6UKuUwVDFYzi.ybE1mRiFVXyv3Jmd9JmLXsVNIiBGFnG',
  chips: 999999,
  isAdmin: true
};

// ─── Auth Middleware ────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─── Auth Routes ────────────────────────────────────────────────────────────

router.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ username, email, password_hash: passwordHash, chips: 1000 })
    .select('id, username, email, chips, is_admin')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
    return res.status(500).json({ error: error.message });
  }

  const token = jwt.sign({ id: data.id, username: data.username, isAdmin: data.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: data });
});

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // Local admin bypass — works without Supabase
  if (username === LOCAL_ADMIN.username) {
    const valid = await bcrypt.compare(password, LOCAL_ADMIN.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, isAdmin: true }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, email: LOCAL_ADMIN.email, chips: LOCAL_ADMIN.chips, isAdmin: true } });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.is_banned) return res.status(403).json({ error: 'Account is banned' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips, isAdmin: user.is_admin } });
});

// ─── Profile ────────────────────────────────────────────────────────────────

router.get('/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, created_at')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ─── Tables ─────────────────────────────────────────────────────────────────

router.get('/tables', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tables')
    .select('*, table_seats(count)')
    .neq('status', 'closed')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/tables', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, game_type, stakes_small_blind, stakes_big_blind, max_players, rake_percent } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const { data, error } = await supabaseAdmin
    .from('tables')
    .insert({
      name,
      game_type: game_type || 'holdem',
      stakes_small_blind: stakes_small_blind || 5,
      stakes_big_blind: stakes_big_blind || 10,
      max_players: max_players || 9,
      rake_percent: rake_percent || 5
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/tables/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('tables')
    .update({ status: 'closed' })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── Tournaments ─────────────────────────────────────────────────────────────

router.get('/tournaments', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tournaments')
    .select('*, tournament_players(count)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/tournaments', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, buy_in, starting_chips, blind_schedule } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const { data, error } = await supabaseAdmin
    .from('tournaments')
    .insert({ name, buy_in: buy_in || 100, starting_chips: starting_chips || 10000, blind_schedule })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/tournaments/:id/register', authMiddleware, async (req, res) => {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('chips')
    .eq('id', req.user.id)
    .single();

  const { data: tournament } = await supabaseAdmin
    .from('tournaments')
    .select('buy_in, status')
    .eq('id', req.params.id)
    .single();

  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  if (tournament.status !== 'registering') return res.status(400).json({ error: 'Registration closed' });
  if (user.chips < tournament.buy_in) return res.status(400).json({ error: 'Insufficient chips' });

  await supabaseAdmin
    .from('users')
    .update({ chips: user.chips - tournament.buy_in })
    .eq('id', req.user.id);

  const { data, error } = await supabaseAdmin
    .from('tournament_players')
    .insert({ tournament_id: req.params.id, user_id: req.user.id, chips: 0 })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Jackpot ─────────────────────────────────────────────────────────────────

router.get('/jackpot', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jackpot')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/jackpot/award', authMiddleware, adminMiddleware, async (req, res) => {
  const { data: jackpot } = await supabaseAdmin
    .from('jackpot')
    .select('*')
    .eq('id', 1)
    .single();

  if (!jackpot || jackpot.current_amount === 0) {
    return res.status(400).json({ error: 'No jackpot to award' });
  }

  if (jackpot.highest_hand_user_id) {
    await supabaseAdmin
      .from('users')
      .update({ chips: supabaseAdmin.raw(`chips + ${jackpot.current_amount}`) })
      .eq('id', jackpot.highest_hand_user_id);
  }

  const { error } = await supabaseAdmin
    .from('jackpot')
    .update({
      last_awarded_at: new Date().toISOString(),
      last_awarded_to: jackpot.highest_hand_user_id,
      current_amount: 0,
      timer_started_at: new Date().toISOString(),
      highest_hand_rank: -1,
      highest_hand_user_id: null
    })
    .eq('id', 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, awarded: jackpot.current_amount });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

router.get('/admin/players', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/players/:id/chips', authMiddleware, adminMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== 'number') return res.status(400).json({ error: 'Amount required' });

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('chips')
    .eq('id', req.params.id)
    .single();

  const newChips = Math.max(0, (user?.chips || 0) + amount);
  const { error } = await supabaseAdmin
    .from('users')
    .update({ chips: newChips })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, newChips });
});

router.post('/admin/players/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  const { banned } = req.body;
  const { error } = await supabaseAdmin
    .from('users')
    .update({ is_banned: banned })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get('/admin/rake-report', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('hands')
    .select('table_id, rake_collected, jackpot_contribution, started_at')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });

  const totalRake = data.reduce((s, h) => s + (h.rake_collected || 0), 0);
  const totalJackpot = data.reduce((s, h) => s + (h.jackpot_contribution || 0), 0);
  res.json({ hands: data, totalRake, totalJackpot });
});

module.exports = router;
