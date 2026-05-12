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
    // Check in-memory ban set for immediate enforcement
    try {
      const { bannedUsers } = require('../socket/handlers');
      if (bannedUsers.has(req.user.id)) {
        return res.status(403).json({ error: 'Your account has been suspended. Contact admin at bostonspokerclub.amitureflops@gmail.com' });
      }
    } catch {}
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
    if (user.is_banned) return res.status(403).json({ error: 'Your account has been suspended. Contact admin at bostonspokerclub.amitureflops@gmail.com' });
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

router.get('/jackpot', authMiddleware, (req, res) => {
  try {
    const { tableJackpots } = require('../socket/handlers');
    const now = Date.now();
    const INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;
    const tables = Array.from(tableJackpots.entries()).map(([tableId, jp]) => {
      const remaining = Math.max(0, INTERVAL_MS - (now - jp.timerStart));
      return {
        tableId, tableName: jp.tableName,
        amount: jp.amount,
        highHandRank: jp.highHandRank,
        highHandUsername: jp.highHandUsername,
        highHandDescription: jp.highHandDescription,
        timerStart: jp.timerStart,
        timerRemainingMs: remaining
      };
    });
    const total = tables.reduce((s, t) => s + t.amount, 0);
    res.json({ tables, total, current_amount: total, timer_started_at: tables[0]?.timerStart ? new Date(tables[0].timerStart).toISOString() : null });
  } catch (e) {
    res.json({ tables: [], total: 0, current_amount: 0 });
  }
});

// Admin: manually set high hand for a specific table
router.post('/jackpot/high-hand', authMiddleware, adminMiddleware, async (req, res) => {
  const { tableId, description, holder, handRank } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const { tableJackpots, activeGames } = require('../socket/handlers');
    const io = req.app.get('io');
    const INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;

    if (tableId) {
      let jp = tableJackpots.get(tableId);
      if (!jp) {
        const game = activeGames ? activeGames.get(tableId) : null;
        jp = { tableName: game?.tableName || tableId.slice(0, 8), amount: 0, highHandRank: -1, highHandUserId: null, highHandUsername: null, highHandDescription: null, timerStart: Date.now() };
        tableJackpots.set(tableId, jp);
      }
      jp.highHandDescription = String(description).slice(0, 120);
      jp.highHandUsername = holder ? String(holder).slice(0, 60) : jp.highHandUsername;
      if (handRank !== undefined && Number(handRank) > jp.highHandRank) jp.highHandRank = Number(handRank);
      jp.timerStart = Date.now();
      if (io) io.emit('jackpot_state', (() => {
        const tables = Array.from(tableJackpots.entries()).map(([tid, j]) => ({ tableId: tid, tableName: j.tableName, amount: j.amount, highHandRank: j.highHandRank, highHandUsername: j.highHandUsername, highHandDescription: j.highHandDescription, timerRemainingMs: Math.max(0, INTERVAL_MS - (Date.now() - j.timerStart)) }));
        return { tables, total: tables.reduce((s, t) => s + t.amount, 0), amount: tables.reduce((s, t) => s + t.amount, 0) };
      })());
    }
    // Keep legacy state for backward compat
    highHandState = { description: String(description).slice(0, 120), holder: holder ? String(holder).slice(0, 60) : '', setAt: new Date().toISOString() };
    res.json({ success: true, tableId, description, holder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: award jackpot for a specific table
router.post('/jackpot/award', authMiddleware, adminMiddleware, async (req, res) => {
  const { tableId } = req.body || {};
  try {
    const { tableJackpots } = require('../socket/handlers');
    const io = req.app.get('io');

    if (tableId) {
      const jp = tableJackpots.get(tableId);
      if (!jp || jp.amount === 0) return res.status(400).json({ error: 'No jackpot to award for this table' });
      const awarded = jp.amount;
      const awardedTo = jp.highHandUserId;
      // Credit chips
      if (awardedTo) {
        try {
          const { data } = await supabaseAdmin.from('users').select('chips').eq('id', awardedTo).single();
          if (data) await supabaseAdmin.from('users').update({ chips: data.chips + awarded }).eq('id', awardedTo);
        } catch {}
        if (io) {
          for (const [, s] of io.sockets.sockets) {
            if (s.user && s.user.id === awardedTo) {
              s.emit('jackpot_won', { amount: awarded, message: `🏆 You won the High Hand Jackpot: $${awarded}!` });
            }
          }
          io.emit('jackpot_awarded', { amount: awarded, winnerId: awardedTo, tableId });
        }
      }
      jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
      jp.highHandUsername = null; jp.highHandDescription = null; jp.timerStart = Date.now();
      if (io) {
        const INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;
        const tables = Array.from(tableJackpots.entries()).map(([tid, j]) => ({ tableId: tid, tableName: j.tableName, amount: j.amount, highHandRank: j.highHandRank, highHandUsername: j.highHandUsername, highHandDescription: j.highHandDescription, timerRemainingMs: Math.max(0, INTERVAL_MS - (Date.now() - j.timerStart)) }));
        io.emit('jackpot_state', { tables, total: tables.reduce((s, t) => s + t.amount, 0), amount: tables.reduce((s, t) => s + t.amount, 0) });
      }
      return res.json({ success: true, awarded, awardedTo });
    }
    res.status(400).json({ error: 'tableId required' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const { full_name, nickname, phone, email, address, city, state, zip, username, role, is_banned, chips_adj, chips_set } = req.body;
  const targetId = req.params.id;

  // Fetch current state to derive changes
  const { data: current } = await supabaseAdmin.from('users').select('chips, is_admin, is_banned').eq('id', targetId).single();

  // Build update object — only include defined fields
  const updates = {};
  if (full_name  !== undefined) updates.full_name  = full_name;
  if (nickname   !== undefined) updates.nickname   = nickname;
  if (phone      !== undefined) updates.phone      = phone;
  if (email      !== undefined) updates.email      = email;
  if (address    !== undefined) updates.address    = address;
  if (city       !== undefined) updates.city       = city;
  if (state      !== undefined) updates.state      = state;
  if (zip        !== undefined) updates.zip        = zip;
  if (username   !== undefined && username) updates.username = username;

  // Role changes
  let newIsAdmin = current?.is_admin ?? false;
  let roleChanged = false;
  if (role !== undefined) {
    if (role === 'admin') {
      updates.is_admin = true;
      newIsAdmin = true;
      roleChanged = true;
      // Remove from hostSet if they become admin
      hostSet.delete(targetId);
    } else if (role === 'host') {
      updates.is_admin = false;
      newIsAdmin = false;
      hostSet.add(targetId);
      roleChanged = true;
    } else {
      updates.is_admin = false;
      newIsAdmin = false;
      hostSet.delete(targetId);
      roleChanged = true;
    }
  }

  // Ban changes
  let banChanged = false;
  if (is_banned !== undefined) {
    updates.is_banned = is_banned;
    banChanged = true;
  }

  // Chip update: set takes priority over adjust
  if (chips_set !== undefined && chips_set !== null) {
    updates.chips = Math.max(0, Number(chips_set));
  } else if (chips_adj && chips_adj !== 0 && current) {
    updates.chips = Math.max(0, (current.chips || 0) + chips_adj);
  }

  // Attempt update; if a column doesn't exist yet, strip it and retry
  let updateError = null;
  const remaining = { ...updates };
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!Object.keys(remaining).length) break;
    const { error } = await supabaseAdmin.from('users').update(remaining).eq('id', targetId);
    if (!error) { updateError = null; break; }
    updateError = error;
    const missing = error.message.match(/column (?:[\w.]*\.)?["']?(\w+)["']? does not exist/);
    if (missing) {
      const col = missing[1];
      console.warn(`[editPlayer] column "${col}" missing in users table — skipping`);
      delete remaining[col];
    } else {
      break;
    }
  }
  if (updateError) return res.status(500).json({ error: updateError.message });

  // Fire side effects
  if (roleChanged) {
    const isNowHost = role === 'host';
    appEvents.emit('host:change', { userId: targetId, isHost: isNowHost });
    if (role === 'admin' || (current?.is_admin && role !== 'admin')) {
      appEvents.emit('admin:change', { userId: targetId, isAdmin: newIsAdmin });
    }
  }
  if (banChanged) {
    if (is_banned) {
      appEvents.emit('player:banned', { userId: targetId });
    } else {
      appEvents.emit('player:unbanned', { userId: targetId });
    }
  }

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
  // Kick immediately if banning, re-allow if unbanning
  if (banned) {
    appEvents.emit('player:banned', { userId: req.params.id });
  } else {
    appEvents.emit('player:unbanned', { userId: req.params.id });
  }
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

router.get('/admin/notifications', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { adminNotifs } = require('../socket/handlers');
    res.json(adminNotifs.slice(0, 100));
  } catch { res.json([]); }
});

router.get('/admin/rail', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { railQueue } = require('../socket/handlers');
    res.json(railQueue);
  } catch { res.json([]); }
});

router.get('/admin/table-requests', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { tableRequests } = require('../socket/handlers');
    res.json(tableRequests.slice(0, 50));
  } catch { res.json([]); }
});

router.post('/admin/players/:id/admin', authMiddleware, adminMiddleware, async (req, res) => {
  const { isAdmin: makeAdmin } = req.body;
  const { error } = await supabaseAdmin.from('users').update({ is_admin: !!makeAdmin }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  // Update their JWT on next login — for now notify via socket
  const appEvents = require('../events');
  appEvents.emit('admin:change', { userId: req.params.id, isAdmin: !!makeAdmin });
  res.json({ success: true, is_admin: !!makeAdmin });
});

router.get('/admin/hosts', authMiddleware, adminMiddleware, async (req, res) => {
  const hostIds = Array.from(hostSet);
  if (!hostIds.length) return res.json([]);

  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone')
    .in('id', hostIds);

  if (error) return res.status(500).json({ error: error.message });

  try {
    const { sessionRake, tableRequests } = require('../socket/handlers');

    const hosts = (data || []).map(host => {
      const hostReqs = tableRequests.filter(r => r.hostId === host.id);
      const pendingReqs = hostReqs.filter(r => r.status === 'pending');
      const approvedReqs = hostReqs.filter(r => r.status === 'approved' && r.tableId);

      // Session rake from their approved tables
      let rakeContrib = 0;
      for (const r of approvedReqs) {
        const entry = sessionRake.byTable.get(r.tableId);
        if (entry) rakeContrib += entry.total;
      }

      return {
        ...host,
        is_host: true,
        tableRequests: hostReqs.slice(0, 20),
        pendingCount: pendingReqs.length,
        sessionRakeContrib: rakeContrib
      };
    });

    res.json(hosts);
  } catch {
    res.json((data || []).map(h => ({ ...h, is_host: true, tableRequests: [], pendingCount: 0, sessionRakeContrib: 0 })));
  }
});

router.get('/admin/messages', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { broadcastMessages } = require('../socket/handlers');
    res.json(broadcastMessages.slice(0, 100));
  } catch { res.json([]); }
});

// Send a broadcast message to all connected sockets (or a specific user)
router.post('/admin/send-message', authMiddleware, adminMiddleware, async (req, res) => {
  const { message, targetUserId } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  const io = req.app.get('io');
  const { broadcastMessages } = require('../socket/handlers');

  // Build next sequence ID
  const id = Date.now();
  const msg = {
    id,
    from: req.user.username,
    message: message.trim().slice(0, 500),
    targetUserId: targetUserId || null,
    targetAll: !targetUserId,
    sentAt: Date.now()
  };

  // Persist in memory
  broadcastMessages.unshift(msg);
  if (broadcastMessages.length > 200) broadcastMessages.pop();

  console.log(`[broadcast/api] "${req.user.username}" → ${targetUserId ? 'uid=' + targetUserId : 'ALL'} | "${msg.message}"`);

  let delivered = 0;
  if (io) {
    if (targetUserId) {
      // Send to every socket belonging to this user
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === targetUserId) {
          s.emit('broadcast_message', msg);
          delivered++;
        }
      }
    } else {
      // Send to every connected socket — no exceptions, no filtering
      io.emit('broadcast_message', msg);
      delivered = io.sockets.sockets.size;
      console.log(`[broadcast/api] io.emit sent to ${delivered} sockets`);
    }
  } else {
    console.warn('[broadcast/api] io not available on app');
  }

  // Email offline players
  try {
    const { sendBroadcastEmail } = require('../mail');
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('id, email, username')
      .eq('is_banned', false)
      .not('email', 'is', null);
    const recipients = (allUsers || []).filter(u => u.id !== req.user.id && u.email);
    if (recipients.length > 0) {
      sendBroadcastEmail({ from: req.user.username, message: msg.message, recipients }).catch(() => {});
      console.log(`[broadcast/api] email queued for ${recipients.length} players`);
    }
  } catch (e) {
    console.warn('[broadcast/api] email error:', e.message);
  }

  res.json({ ok: true, delivered, message: msg });
});

// Test endpoint — sends a test broadcast to all connected sockets
router.get('/test-broadcast', authMiddleware, adminMiddleware, (req, res) => {
  const io = req.app.get('io');
  if (!io) return res.status(500).json({ error: 'io not available' });
  const msg = {
    id: Date.now(),
    from: 'System',
    message: 'TEST BROADCAST — if you see this, socket delivery is working!',
    targetAll: true,
    sentAt: Date.now()
  };
  io.emit('broadcast_message', msg);
  const count = io.sockets.sockets.size;
  console.log(`[test-broadcast] sent to ${count} sockets`);
  res.json({ ok: true, socketCount: count, msg });
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

// Any authenticated player can fetch their message inbox
router.get('/messages', authMiddleware, (req, res) => {
  try {
    const { broadcastMessages } = require('../socket/handlers');
    // Return messages relevant to this player (broadcast to all, or directly targeted)
    const userId = req.user.id;
    const inbox = broadcastMessages.filter(m => m.targetAll || m.targetUserId === userId);
    res.json(inbox.slice(0, 100));
  } catch { res.json([]); }
});

module.exports = router;
