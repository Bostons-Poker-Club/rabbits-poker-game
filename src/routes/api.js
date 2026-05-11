'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');
const appEvents = require('../events');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// In-memory high hand state
let highHandState = { description: '', holder: '', setAt: null };

// In-memory host set — admin grants host status; resets on server restart
const hostSet = new Set();

const LOCAL_ADMIN = {
  id: 'local-admin-000',
  username: process.env.ADMIN_USERNAME || 'admin',
  email: 'admin@rabbsroom.com',
  passwordHash: process.env.ADMIN_PASSWORD_HASH || '$2a$10$IhLhqS2Zh/GR/BaWT6X5EOu.trshg1Nhuru73B6NBA353.zIWC5XG',
  chips: 100000,
  isAdmin: true
};

const ADMIN_CHIP_REFILL = 100000;
const ADMIN_CHIP_LOW_THRESHOLD = 10000;

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

function hostMiddleware(req, res, next) {
  if (req.user?.isAdmin || hostSet.has(req.user?.id)) return next();
  return res.status(403).json({ error: 'Host or admin access required' });
}

// ─── Auth Routes ────────────────────────────────────────────────────────────

router.post('/auth/register', async (req, res) => {
  const { username, email, password, full_name, nickname, phone } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Try with extended profile fields first; fall back to base fields if migration not yet applied
  let data, error;
  ({ data, error } = await supabaseAdmin
    .from('users')
    .insert({ username, email, password_hash: passwordHash, chips: 0,
              full_name: full_name || null, nickname: nickname || null, phone: phone || null })
    .select('id, username, email, chips, is_admin')
    .single());

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
    if (error.message?.includes('column') || error.message?.includes('does not exist')) {
      ({ data, error } = await supabaseAdmin
        .from('users')
        .insert({ username, email, password_hash: passwordHash, chips: 0 })
        .select('id, username, email, chips, is_admin')
        .single());
    }
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
      return res.status(500).json({ error: error.message });
    }
  }

  // Force chips to 0 regardless of DB default — belt-and-suspenders
  await supabaseAdmin.from('users').update({ chips: 0 }).eq('id', data.id);

  const token = jwt.sign({ id: data.id, username: data.username, isAdmin: data.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  appEvents.emit('player:registered', { userId: data.id, username: data.username, nickname: nickname || null, phone: phone || null });
  // Always return chips: 0 to the client — do not echo what the DB returned
  res.json({ token, user: { id: data.id, username: data.username, email: data.email, chips: 0, isAdmin: data.is_admin } });
});

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // Try Supabase first
  const { data: user, error: dbError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  console.log(`[login] user=${username} db_found=${!!user} db_error=${dbError?.code || 'none'}`);

  if (user) {
    if (user.is_banned) return res.status(403).json({ error: 'Account is banned' });
    const valid = await bcrypt.compare(password, user.password_hash);
    console.log(`[login] db bcrypt valid=${valid}`);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips, isAdmin: user.is_admin } });
  }

  // Supabase unavailable or user not found — fall back to local admin bypass
  if (username === LOCAL_ADMIN.username) {
    const valid = await bcrypt.compare(password, LOCAL_ADMIN.passwordHash);
    console.log(`[login] local bypass bcrypt valid=${valid}`);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, isAdmin: true }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, email: LOCAL_ADMIN.email, chips: LOCAL_ADMIN.chips, isAdmin: true } });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

// ─── Health / Diagnostics ───────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || 'NOT SET';
  const hasAnonKey  = !!process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY !== 'placeholder';
  const hasSvcKey   = !!process.env.SUPABASE_SERVICE_KEY && process.env.SUPABASE_SERVICE_KEY !== 'placeholder';
  const hasJwt      = !!process.env.JWT_SECRET && process.env.JWT_SECRET !== 'dev-secret-change-me';

  let dbStatus = 'untested';
  let userCount = null;
  try {
    const { count, error } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });
    dbStatus = error ? `error: ${error.message}` : 'connected';
    userCount = count;
  } catch (e) {
    dbStatus = `exception: ${e.message}`;
  }

  res.json({
    status: 'ok',
    supabaseUrl: supabaseUrl.replace(/https?:\/\//, '').split('.')[0] + '.supabase.co',
    hasAnonKey,
    hasSvcKey,
    hasJwt,
    db: dbStatus,
    userCount,
    nodeVersion: process.version
  });
});

// ─── Profile ────────────────────────────────────────────────────────────────

router.get('/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, created_at')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'User not found' });

  // Auto-refill admin chips when low
  if (data.is_admin && data.chips < ADMIN_CHIP_LOW_THRESHOLD) {
    await supabaseAdmin.from('users').update({ chips: ADMIN_CHIP_REFILL }).eq('id', data.id);
    data.chips = ADMIN_CHIP_REFILL;
  }

  res.json({ ...data, is_host: hostSet.has(req.user.id) });
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

router.post('/tables', authMiddleware, hostMiddleware, async (req, res) => {
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

router.delete('/tournaments/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('tournaments')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
  res.json({ ...data, high_hand_description: highHandState.description, high_hand_holder: highHandState.holder, high_hand_set_at: highHandState.setAt });
});

router.post('/jackpot/high-hand', authMiddleware, adminMiddleware, async (req, res) => {
  const { description, holder } = req.body;
  if (!description || !holder) return res.status(400).json({ error: 'description and holder required' });
  highHandState = { description: String(description).slice(0, 120), holder: String(holder).slice(0, 60), setAt: new Date().toISOString() };
  await supabaseAdmin.from('jackpot').update({ timer_started_at: highHandState.setAt }).eq('id', 1);
  res.json({ success: true, ...highHandState });
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

router.get('/admin/pending-players', authMiddleware, adminMiddleware, async (req, res) => {
  // Players with 0 chips who haven't been seated yet
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, created_at, full_name, nickname, phone')
    .eq('chips', 0)
    .eq('is_admin', false)
    .order('created_at', { ascending: false });

  if (error && (error.message?.includes('column') || error.message?.includes('does not exist'))) {
    ({ data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, email, chips, created_at')
      .eq('chips', 0)
      .eq('is_admin', false)
      .order('created_at', { ascending: false }));
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/admin/players', authMiddleware, adminMiddleware, async (req, res) => {
  // Try with extended profile columns; fall back to base columns if migration not yet applied
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone, address, city, state, zip')
    .order('created_at', { ascending: false });

  if (error && (error.message?.includes('column') || error.message?.includes('does not exist'))) {
    ({ data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, email, chips, is_admin, is_banned, created_at')
      .order('created_at', { ascending: false }));
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(p => ({ ...p, is_host: hostSet.has(p.id) })));
});

router.get('/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone, address, city, state, zip')
    .eq('id', req.params.id)
    .single();

  if (error && (error.message?.includes('column') || error.message?.includes('does not exist'))) {
    ({ data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, email, chips, is_admin, is_banned, created_at')
      .eq('id', req.params.id)
      .single());
  }

  if (error) return res.status(404).json({ error: 'Player not found' });
  res.json({ ...data, is_host: hostSet.has(data.id) });
});

router.put('/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { full_name, nickname, phone, email, address, city, state, zip } = req.body;
  const { error } = await supabaseAdmin
    .from('users')
    .update({ full_name, nickname, phone, email, address, city, state, zip })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.delete('/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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

router.post('/admin/players/:id/seat', authMiddleware, adminMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Positive amount required' });

  const { data: user } = await supabaseAdmin.from('users').select('chips').eq('id', req.params.id).single();
  const newChips = (user?.chips || 0) + amount;
  const { error } = await supabaseAdmin.from('users').update({ chips: newChips }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, newChips });
});

router.post('/admin/players/:id/host', authMiddleware, adminMiddleware, async (req, res) => {
  const { isHost } = req.body;
  if (isHost) { hostSet.add(req.params.id); } else { hostSet.delete(req.params.id); }
  appEvents.emit('host:change', { userId: req.params.id, isHost: !!isHost });
  res.json({ success: true, is_host: !!isHost });
});

router.post('/admin/refill-chips', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ chips: ADMIN_CHIP_REFILL })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, chips: ADMIN_CHIP_REFILL });
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

router.get('/admin/session-rake', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { sessionRake } = require('../socket/handlers');
    const byTable = Array.from(sessionRake.byTable.entries()).map(([id, t]) => ({
      tableId: id, tableName: t.tableName, total: t.total,
      handCount: t.hands.length,
      hands: t.hands
    }));
    res.json({
      total: sessionRake.total,
      byTable,
      // flat list of all hands newest-first for the live feed
      hands: byTable.flatMap(t => t.hands.map(h => ({ ...h, tableId: t.tableId, tableName: t.tableName })))
              .sort((a, b) => b.ts - a.ts).slice(0, 100)
    });
  } catch {
    res.json({ total: 0, byTable: [], hands: [] });
  }
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
