'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../db/supabase');
const appEvents = require('../events');
const { logTransaction } = require('../transactions');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// In-memory high hand state
let highHandState = { description: '', holder: '', setAt: null };

// In-memory buy-in requests: { id, userId, username, amount, paymentMethod, notes, requestedAt, status }
const buyInRequests = [];
let buyInSeq = 0;

// In-memory host set — populated from DB at startup; persisted on change
const hostSet = new Set();

// Load persisted host set from DB
async function initHostSet() {
  try {
    const { data } = await supabaseAdmin.from('users').select('id').eq('is_host', true);
    if (data) data.forEach(u => hostSet.add(u.id));
    console.log(`[init] Loaded ${hostSet.size} hosts from DB`);
  } catch (e) {
    console.warn('[init] Could not load host set:', e.message);
  }
}
initHostSet();

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
  if (req.user?.isAdmin || hostSet.has(req.user?.id)) {
    // Block fee-suspended hosts/admins from hosting features
    try {
      const { feeSuspendedUsers } = require('../fees');
      if (feeSuspendedUsers.has(req.user.id)) {
        return res.status(403).json({ error: 'Your hosting privileges are suspended due to an unpaid monthly fee. Contact bostonspokerclub.amitureflops@gmail.com' });
      }
    } catch {}
    return next();
  }
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

  // Block registration with email or phone belonging to a banned account
  const orFilters = [`email.eq.${email}`];
  if (phone) orFilters.push(`phone.eq.${phone}`);
  const { data: bannedMatch } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('is_banned', true)
    .or(orFilters.join(','))
    .limit(1)
    .single();
  if (bannedMatch) {
    return res.status(403).json({ error: 'This email/phone is associated with a suspended account. Contact bostonspokerclub.amitureflops@gmail.com' });
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
      rake_percent: rake_percent || 5,
      host_id: req.user.id
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/tables/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const tableId = req.params.id;

  // Record rake split + session report before closing
  try {
    const { data: tbl } = await supabaseAdmin.from('tables').select('name, host_id, game_type').eq('id', tableId).single();
    const { sessionRake } = require('../socket/handlers');
    const entry = sessionRake.byTable.get(tableId);
    const totalRake    = entry?.total      || 0;
    const potVolume    = entry?.potVolume  || 0;
    const handsPlayed  = entry?.hands?.length || 0;
    const handsDetail  = entry?.hands || [];
    const gameType     = tbl?.game_type || 'holdem';

    // Resolve host info (prefer in-memory game data, fall back to DB)
    let hostId       = entry?.hostId       || tbl?.host_id || null;
    let hostUsername = entry?.hostUsername || null;
    let hostType     = entry?.hostType     || null;
    let hostPercent  = entry?.hostPercent  || 0;
    let hostEmail    = null;

    if (hostId && !hostUsername) {
      try {
        const { data: hostUser } = await supabaseAdmin.from('users').select('username, email, is_admin, host_type').eq('id', hostId).single();
        if (hostUser) {
          hostUsername = hostUser.username;
          hostType     = hostUser.is_admin ? 'admin' : (hostUser.host_type || 'host');
          hostPercent  = hostType === 'admin' ? 20 : 40;
          hostEmail    = hostUser.email;
        }
      } catch {}
    } else if (hostId) {
      // Username known but we still need the email
      try {
        const { data: hostUser } = await supabaseAdmin.from('users').select('email').eq('id', hostId).single();
        hostEmail = hostUser?.email || null;
      } catch {}
    }

    const hostAmount  = Math.floor(totalRake * hostPercent / 100);
    const houseAmount = totalRake - hostAmount;
    const tableName   = tbl?.name || tableId.slice(0, 8);

    if (totalRake > 0) {
      await supabaseAdmin.from('table_rake_splits').insert({
        table_id: tableId, table_name: tableName, total_rake: totalRake,
        host_id: hostId, host_username: hostUsername, host_type: hostType,
        host_percent: hostPercent, host_amount: hostAmount, house_amount: houseAmount
      });
    }

    // Save detailed session report
    const { data: reportRow } = await supabaseAdmin.from('session_reports').insert({
      table_id: tableId, table_name: tableName, game_type: gameType,
      total_rake: totalRake, pot_volume: potVolume, hands_played: handsPlayed,
      host_id: hostId, host_username: hostUsername, host_type: hostType,
      host_percent: hostPercent, host_amount: hostAmount, house_amount: houseAmount,
      hands_detail: handsDetail
    }).select('id').single();

    const { sendSessionReportEmail, sendHostSessionEmail } = require('../mail');

    // Email full report to admin
    sendSessionReportEmail({
      reportId: reportRow?.id,
      tableName, gameType, totalRake, potVolume, handsPlayed,
      hostUsername, hostType, hostPercent, hostAmount, houseAmount,
      hands: handsDetail
    }).catch(() => {});

    // Email earnings summary to host (if different from admin)
    if (hostEmail && hostAmount > 0) {
      sendHostSessionEmail({
        to: hostEmail,
        hostUsername, tableName, gameType, handsPlayed,
        totalRake, hostPercent, hostAmount, houseAmount,
        reportId: reportRow?.id
      }).catch(() => {});
    }

  } catch (e) {
    console.warn('[close-table] Session report error:', e.message);
  }

  const { error } = await supabaseAdmin.from('tables').update({ status: 'closed' }).eq('id', tableId);
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
    const { getAllJackpotState } = require('../socket/handlers');
    const state = getAllJackpotState();
    res.json({ ...state, current_amount: state.total, timer_started_at: state.tables[0]?.timerStart ? new Date(state.tables[0].timerStart).toISOString() : null });
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

// Admin: activate / deactivate / hold / resume jackpot for a specific table
router.post('/jackpot/control', authMiddleware, adminMiddleware, async (req, res) => {
  const { tableId, action } = req.body;
  if (!tableId) return res.status(400).json({ error: 'tableId required' });
  if (!['activate', 'deactivate', 'hold', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'action must be activate, deactivate, hold, or resume' });
  }
  try {
    const { tableJackpots, pendingJackpotPayouts, getAllJackpotState } = require('../socket/handlers');
    const io = req.app.get('io');
    const jp = tableJackpots.get(tableId);
    if (!jp) return res.status(404).json({ error: 'No jackpot found for this table' });

    switch (action) {
      case 'activate':
        jp.isActive = true;
        jp.isOnHold = false;
        jp.awaitingPayout = false;
        jp.timerStart = Date.now();
        jp.pausedAt = null;
        pendingJackpotPayouts.delete(tableId);
        break;
      case 'deactivate':
        jp.isActive = false;
        jp.isOnHold = false;
        jp.awaitingPayout = false;
        jp.pausedAt = null;
        pendingJackpotPayouts.delete(tableId);
        break;
      case 'hold':
        if (!jp.isActive || jp.awaitingPayout) return res.status(400).json({ error: 'Cannot hold: jackpot not active or awaiting payout' });
        jp.isOnHold = true;
        jp.pausedAt = Date.now();
        break;
      case 'resume':
        if (jp.pausedAt) {
          jp.timerStart += (Date.now() - jp.pausedAt);
          jp.pausedAt = null;
        }
        jp.isOnHold = false;
        break;
    }

    if (io) io.emit('jackpot_state', getAllJackpotState());
    res.json({ success: true, action, tableId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: award jackpot for a specific table
router.post('/jackpot/award', authMiddleware, adminMiddleware, async (req, res) => {
  const { tableId } = req.body || {};
  if (!tableId) return res.status(400).json({ error: 'tableId required' });
  try {
    const { tableJackpots, pendingJackpotPayouts, awardTableJackpot } = require('../socket/handlers');
    const io = req.app.get('io');
    if (!io) return res.status(500).json({ error: 'io not available' });

    // Check pending payout (from expired timer) first
    const pending = pendingJackpotPayouts.get(tableId);
    if (pending) {
      const { amount, userId, username, hand, tableName } = pending;
      await awardTableJackpot(io, tableId, amount, userId, username, hand, tableName);
      return res.json({ success: true, awarded: amount, awardedTo: userId });
    }

    // Check live jackpot
    const jp = tableJackpots.get(tableId);
    if (!jp || jp.amount === 0) return res.status(400).json({ error: 'No jackpot to award for this table' });
    const { amount: awarded, highHandUserId: awardedTo, highHandUsername: wName, highHandDescription: wHand, tableName: tName } = jp;
    jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
    jp.highHandUsername = null; jp.highHandDescription = null; jp.timerStart = Date.now();
    await awardTableJackpot(io, tableId, awarded, awardedTo, wName, wHand, tName);
    return res.json({ success: true, awarded, awardedTo });
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
      updates.is_host  = false;
      updates.host_type = 'admin';
      newIsAdmin = true;
      roleChanged = true;
      hostSet.delete(targetId);
    } else if (role === 'host') {
      updates.is_admin = false;
      updates.is_host  = true;
      updates.host_type = 'host';
      newIsAdmin = false;
      hostSet.add(targetId);
      roleChanged = true;
    } else {
      updates.is_admin = false;
      updates.is_host  = false;
      updates.host_type = null;
      newIsAdmin = false;
      hostSet.delete(targetId);
      roleChanged = true;
    }
  }

  // Ban changes
  let banChanged = false;
  if (is_banned !== undefined) {
    updates.is_banned = is_banned;
    if (is_banned && !current?.is_banned) {
      updates.banned_at = new Date().toISOString();
    } else if (!is_banned) {
      updates.banned_at = null;
      updates.ban_reason = null;
    }
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
    .select('chips, phone, email, username')
    .eq('id', req.params.id)
    .single();

  const newChips = Math.max(0, (user?.chips || 0) + amount);
  const { error } = await supabaseAdmin
    .from('users')
    .update({ chips: newChips })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  if (amount > 0 && (user?.phone || user?.email)) {
    const { sendPlayerEmail, sendPlayerSMS } = require('../mail');
    const notifText = `Boston Poker Club: $${amount.toLocaleString()} chips added to your account. You can now join a table!`;
    const notifHtml = `<p>Hi <strong>${user.username || 'there'}</strong>,</p><p><strong>$${amount.toLocaleString()} chips</strong> have been added to your account.</p><p>New balance: <strong>$${newChips.toLocaleString()}</strong> chips.</p><p>You can now join a table — good luck!<br>— Boston Poker Club</p>`;
    if (user.phone) sendPlayerSMS({ phone: user.phone, text: notifText }).catch(() => {});
    if (user.email) sendPlayerEmail({ to: user.email, subject: `$${amount.toLocaleString()} chips added — Boston Poker Club`, text: notifText, html: notifHtml }).catch(() => {});
  }

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
  if (isHost) {
    hostSet.add(req.params.id);
    await supabaseAdmin.from('users').update({ is_host: true, host_type: 'host' }).eq('id', req.params.id).catch(() => {});
  } else {
    hostSet.delete(req.params.id);
    await supabaseAdmin.from('users').update({ is_host: false, host_type: null }).eq('id', req.params.id).catch(() => {});
  }
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
  const { banned, ban_reason } = req.body;
  const updates = { is_banned: banned };
  if (banned) {
    updates.banned_at = new Date().toISOString();
    updates.ban_reason = ban_reason || null;
  } else {
    updates.banned_at = null;
    updates.ban_reason = null;
  }
  const { error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (banned) {
    appEvents.emit('player:banned', { userId: req.params.id });
  } else {
    appEvents.emit('player:unbanned', { userId: req.params.id });
  }
  res.json({ success: true });
});

router.get('/admin/banned-players', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, full_name, nickname, phone, email, banned_at, ban_reason')
    .eq('is_banned', true)
    .order('banned_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/admin/session-rake', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { sessionRake } = require('../socket/handlers');
    const byTable = Array.from(sessionRake.byTable.entries()).map(([id, t]) => {
      const hPct = t.hostPercent || 0;
      const hAmt = Math.floor(t.total * hPct / 100);
      return {
        tableId: id, tableName: t.tableName, total: t.total,
        handCount: t.hands.length, potVolume: t.potVolume || 0,
        hostId: t.hostId, hostUsername: t.hostUsername, hostType: t.hostType,
        hostPercent: hPct, hostAmount: hAmt, houseAmount: t.total - hAmt,
        hands: t.hands
      };
    });
    res.json({
      total: sessionRake.total,
      byTable,
      hands: byTable.flatMap(t => t.hands.map(h => ({ ...h, tableId: t.tableId, tableName: t.tableName })))
              .sort((a, b) => b.ts - a.ts).slice(0, 100)
    });
  } catch {
    res.json({ total: 0, byTable: [], hands: [] });
  }
});

router.get('/admin/session-reports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_reports')
      .select('id, table_name, session_date, total_rake, pot_volume, hands_played, host_username, host_type, host_percent, host_amount, house_amount, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/session-reports/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('session_reports').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Report not found' });
  res.json(data);
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
  const updates = { is_admin: !!makeAdmin };
  if (makeAdmin) {
    updates.host_type = 'admin';
    updates.is_host   = false;
    hostSet.delete(req.params.id);
  }
  const { error } = await supabaseAdmin.from('users').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
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

    // Historical rake earnings per host
    const { data: splitData } = await supabaseAdmin
      .from('table_rake_splits')
      .select('host_id, host_amount')
      .in('host_id', hostIds);
    const historicalByHost = {};
    for (const s of (splitData || [])) {
      historicalByHost[s.host_id] = (historicalByHost[s.host_id] || 0) + s.host_amount;
    }

    const hosts = (data || []).map(host => {
      const hostReqs = tableRequests.filter(r => r.hostId === host.id);
      const pendingReqs = hostReqs.filter(r => r.status === 'pending');
      const approvedReqs = hostReqs.filter(r => r.status === 'approved' && r.tableId);

      let sessionRakeContrib = 0;
      for (const r of approvedReqs) {
        const entry = sessionRake.byTable.get(r.tableId);
        if (entry) sessionRakeContrib += entry.total;
      }

      return {
        ...host,
        is_host: true,
        tableRequests: hostReqs.slice(0, 20),
        pendingCount: pendingReqs.length,
        sessionRakeContrib,
        totalRakeEarned: historicalByHost[host.id] || 0
      };
    });

    res.json(hosts);
  } catch {
    res.json((data || []).map(h => ({ ...h, is_host: true, tableRequests: [], pendingCount: 0, sessionRakeContrib: 0, totalRakeEarned: 0 })));
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

  const { pendingMessages } = require('../socket/handlers');
  let delivered = 0;
  let queued = 0;
  if (io) {
    if (targetUserId) {
      let sent = false;
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === targetUserId) {
          s.emit('broadcast_message', msg);
          delivered++;
          sent = true;
        }
      }
      if (!sent) {
        if (!pendingMessages.has(targetUserId)) pendingMessages.set(targetUserId, []);
        pendingMessages.get(targetUserId).push(msg);
        queued++;
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

  // Email all players and queue offline ones for banner on next login
  try {
    const { sendBroadcastEmail } = require('../mail');
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('id, email, username')
      .eq('is_banned', false);
    const onlineIds = new Set();
    if (io) { for (const [, s] of io.sockets.sockets) { if (s.user) onlineIds.add(s.user.id); } }
    const others = (allUsers || []).filter(u => u.id !== req.user.id);
    if (!targetUserId) {
      // Queue offline players for banner on next login
      for (const u of others.filter(u => !onlineIds.has(u.id))) {
        if (!pendingMessages.has(u.id)) pendingMessages.set(u.id, []);
        pendingMessages.get(u.id).push(msg);
        queued++;
      }
    }
    const emailRecipients = others.filter(u => u.email);
    if (emailRecipients.length > 0) {
      sendBroadcastEmail({ from: req.user.username, message: msg.message, recipients: emailRecipients }).catch(() => {});
      console.log(`[broadcast/api] email queued for ${emailRecipients.length} players`);
    }
  } catch (e) {
    console.warn('[broadcast/api] email error:', e.message);
  }

  res.json({ ok: true, delivered, queued, message: msg });
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

router.get('/test-email', async (req, res) => {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'SENDGRID_API_KEY not set' });
  }
  try {
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(apiKey);
    const [response] = await sgMail.send({
      from: 'bostonspokerclub.amitureflops@gmail.com',
      to: 'bostonspokerclub.amitureflops@gmail.com',
      subject: '✅ RabbsRoom Email Test',
      text: `Test email sent at ${new Date().toISOString()}. SendGrid email system is working!`,
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto"><h2 style="color:#1a7a3f">✅ Email System Working</h2><p>Test sent at <strong>${new Date().toISOString()}</strong>.</p><p style="color:#666">RabbsRoom SendGrid delivery is confirmed.</p></div>`
    });
    console.log(`[test-email] SendGrid OK — status: ${response.statusCode}`);
    res.json({ ok: true, sentTo: 'bostonspokerclub.amitureflops@gmail.com', statusCode: response.statusCode });
  } catch (e) {
    console.error('[test-email] FAILED:', e.message);
    res.status(500).json({ ok: false, error: e.message });
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

// Admin: fetch all player replies to admin messages
router.get('/admin/player-replies', authMiddleware, adminMiddleware, (req, res) => {
  const { playerReplies } = require('../socket/handlers');
  res.json(playerReplies.slice(0, 200));
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

// ─── Buy-In Requests ──────────────────────────────────────────────────────────

// Player submits a buy-in request
router.post('/buyin-request', authMiddleware, async (req, res) => {
  const { amount, paymentMethod, notes } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });

  // Fetch nickname + phone so admin sees full player details
  let nickname = '', phone = '';
  try {
    const { data: profile } = await supabaseAdmin
      .from('users').select('nickname, phone').eq('id', req.user.id).single();
    nickname = profile?.nickname || '';
    phone = profile?.phone || '';
  } catch {}

  const req_id = ++buyInSeq;
  const request = {
    id: req_id,
    userId: req.user.id,
    username: req.user.username,
    nickname,
    phone,
    amount: parseInt(amount),
    paymentMethod: String(paymentMethod || 'Cash').slice(0, 50),
    notes: String(notes || '').slice(0, 200),
    requestedAt: Date.now(),
    status: 'pending'
  };
  buyInRequests.unshift(request);

  // Notify all admin sockets in real-time
  const io = req.app.get('io');
  if (io) {
    const { getAdminSockets } = require('../socket/handlers');
    if (getAdminSockets) {
      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:buyin_request', request);
      }
    }
    io.emit('admin:notification_buyin', request);
  }

  // Send email + SMS to admin
  try {
    const { sendAdminEmail } = require('../mail');
    const displayName = nickname ? `${req.user.username} (${nickname})` : req.user.username;
    const subject = `💰 Buy-In Request — ${displayName} $${amount} chips`;
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a7a3f">💰 Buy-In Request — RabbsRoom</h2>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px">
          <tr><td style="padding:8px 14px;color:#555;width:140px">Username</td><td style="padding:8px 14px;font-weight:700">${req.user.username}</td></tr>
          ${nickname ? `<tr style="background:#fff"><td style="padding:8px 14px;color:#555">Nickname</td><td style="padding:8px 14px">${nickname}</td></tr>` : ''}
          ${phone ? `<tr><td style="padding:8px 14px;color:#555">Phone</td><td style="padding:8px 14px">${phone}</td></tr>` : ''}
          <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Amount</td><td style="padding:8px 14px;font-weight:700;font-size:1.1rem">$${amount} chips</td></tr>
          <tr><td style="padding:8px 14px;color:#555">Payment</td><td style="padding:8px 14px">${request.paymentMethod}</td></tr>
          ${notes ? `<tr style="background:#fff"><td style="padding:8px 14px;color:#555">Notes</td><td style="padding:8px 14px">${notes}</td></tr>` : ''}
        </table>
        <p style="margin-top:20px;color:#666">Log in to <a href="https://rabbsroom.com/admin.html" style="color:#1a7a3f">admin panel</a> → Pending Buy-Ins to approve.</p>
      </div>`;
    const text = `Buy-In: ${displayName}${phone ? ' ' + phone : ''} wants $${amount} chips via ${request.paymentMethod}${notes ? '. ' + notes : ''}. Approve: rabbsroom.com/admin.html`;
    await sendAdminEmail({ subject, text, html });
    if (process.env.SENDGRID_API_KEY) {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({ from: 'bostonspokerclub.amitureflops@gmail.com', to: '5085219176@vtext.com', subject: `Buy-In: ${displayName} $${amount}`, text }).catch(() => {});
    }
    console.log(`[buyin] Notification sent for ${displayName} $${amount}`);
  } catch (e) {
    console.warn('[buyin] Notification error:', e.message);
  }

  res.json({ ok: true, requestId: req_id });
});

// Admin: list pending buy-in requests
router.get('/admin/buyin-requests', authMiddleware, adminMiddleware, (req, res) => {
  res.json(buyInRequests.filter(r => r.status === 'pending'));
});

// Admin: approve buy-in request (add chips to player)
router.post('/admin/buyin-requests/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  const request = buyInRequests.find(r => r.id === id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  // Add chips to player
  const { data: user, error: fetchErr } = await supabaseAdmin.from('users').select('chips, email, phone').eq('id', request.userId).single();
  if (fetchErr || !user) return res.status(404).json({ error: 'Player not found' });
  const newChips = (user.chips || 0) + request.amount;
  const { error: updateErr } = await supabaseAdmin.from('users').update({ chips: newChips }).eq('id', request.userId);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  request.status = 'approved';
  request.approvedAt = Date.now();
  request.approvedBy = req.user.username;

  logTransaction({
    userId: request.userId,
    username: request.username,
    type: 'buyin',
    amount: request.amount,
    paymentMethod: request.paymentMethod,
    notes: request.notes || null
  });

  // Notify player via socket
  const io = req.app.get('io');
  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === request.userId) {
        s.emit('chips_received', { amount: request.amount, from: 'Admin', newTotal: newChips });
      }
    }
  }

  // Notify player via email + SMS
  try {
    const { sendPlayerEmail, sendPlayerSMS } = require('../mail');
    const subject = `✅ Buy-In Approved — $${request.amount.toLocaleString()} chips added`;
    const text = `Hi ${request.username},\n\nYour buy-in of $${request.amount.toLocaleString()} chips has been approved and added to your account.\n\nNew balance: $${newChips.toLocaleString()} chips.\n\nGood luck at the tables!\n— RabbsRoom`;
    const html = `<p>Hi <strong>${request.username}</strong>,</p><p>Your buy-in of <strong>$${request.amount.toLocaleString()}</strong> chips has been approved and added to your account.</p><p>New balance: <strong>$${newChips.toLocaleString()}</strong> chips.</p><p>Good luck at the tables!<br>— RabbsRoom</p>`;
    if (user.email) await sendPlayerEmail({ to: user.email, subject, text, html });
    if (user.phone) await sendPlayerSMS({ phone: user.phone, text: `Boston Poker Club: $${request.amount.toLocaleString()} chips added to your account. You can now join a table!` });
  } catch (e) {
    console.warn('[buyin] Player notification error:', e.message);
  }

  console.log(`[buyin] Approved: ${request.username} +$${request.amount} chips (now ${newChips})`);
  res.json({ ok: true, chips: newChips, request });
});

// Admin: deny buy-in request
router.post('/admin/buyin-requests/:id/deny', authMiddleware, adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  const request = buyInRequests.find(r => r.id === id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = 'denied';
  request.deniedAt = Date.now();
  res.json({ ok: true });
});

// Admin: mark buy-in request as paid / unpaid
router.post('/admin/buyin-requests/:id/paid', authMiddleware, adminMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const request = buyInRequests.find(r => r.id === id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.paid = Boolean(req.body.paid);
  res.json({ ok: true });
});

// Admin: get transaction history for a player
router.get('/admin/players/:id/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    if (error.message?.includes('does not exist') || error.message?.includes('relation')) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// ─── Host Applications ────────────────────────────────────────────────────────

// Public: anyone can submit a host application (no account needed yet)
router.post('/auth/apply-host', async (req, res) => {
  const { full_name, phone, email, address, government_id_data, government_id_filename, monthly_fee_agreed, rake_agreed } = req.body;
  if (!full_name)          return res.status(400).json({ error: 'Full legal name is required' });
  if (!phone)              return res.status(400).json({ error: 'Phone number is required' });
  if (!email)              return res.status(400).json({ error: 'Email is required' });
  if (!address)            return res.status(400).json({ error: 'Address is required' });
  if (!government_id_data) return res.status(400).json({ error: 'Government ID photo is required' });
  if (!monthly_fee_agreed) return res.status(400).json({ error: 'Must agree to the $20/month hosting fee' });
  if (!rake_agreed)        return res.status(400).json({ error: 'Must agree to 40% rake contribution' });

  const { data, error } = await supabaseAdmin.from('host_applications').insert({
    full_name: String(full_name).slice(0, 120),
    phone: String(phone).slice(0, 20),
    email: String(email).slice(0, 255),
    address: String(address).slice(0, 500),
    government_id_data: String(government_id_data),
    government_id_filename: government_id_filename ? String(government_id_filename).slice(0, 255) : null,
    monthly_fee_agreed: !!monthly_fee_agreed,
    rake_agreed: !!rake_agreed,
    status: 'pending'
  }).select('id').single();

  if (error) return res.status(500).json({ error: error.message });

  try {
    const { sendAdminEmail } = require('../mail');
    await sendAdminEmail({
      subject: `🎰 Host Application — ${full_name}`,
      text: `New host application from ${full_name} (${email}, ${phone}). Review at admin panel → Applications tab.`,
      html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#1a7a3f">🎰 New Host Application</h2><p><strong>${full_name}</strong><br>Email: ${email}<br>Phone: ${phone}<br>Address: ${address}</p><p>Review at the <a href="https://rabbsroom.com/admin.html" style="color:#1a7a3f">admin panel</a> → Applications tab.</p></div>`
    });
  } catch {}

  res.json({ ok: true, id: data.id });
});

// Admin: list host applications
router.get('/admin/host-applications', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('host_applications')
    .select('id, full_name, phone, email, address, government_id_filename, monthly_fee_agreed, rake_agreed, status, notes, user_id, created_at, reviewed_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Admin: view government ID for an application (data URL only, not stored in list endpoint)
router.get('/admin/host-applications/:id/government-id', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('host_applications')
    .select('government_id_data, government_id_filename')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Application not found' });
  res.json({ data: data.government_id_data, filename: data.government_id_filename });
});

// Admin: approve host application — creates user account and sends welcome email
router.post('/admin/host-applications/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Initial password required (min 6 characters)' });

  const { data: app, error: appErr } = await supabaseAdmin
    .from('host_applications').select('*').eq('id', req.params.id).single();
  if (appErr || !app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'pending') return res.status(400).json({ error: 'Application already processed' });

  // Derive username from email, ensure uniqueness
  let baseUsername = app.email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 20) || 'host';
  let username = baseUsername;
  for (let i = 1; i < 100; i++) {
    const { data: existing } = await supabaseAdmin.from('users').select('id').eq('username', username).maybeSingle();
    if (!existing) break;
    username = baseUsername + i;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: newUser, error: createErr } = await supabaseAdmin.from('users').insert({
    username,
    email: app.email,
    password_hash: passwordHash,
    chips: 0,
    full_name: app.full_name,
    phone: app.phone,
    address: app.address,
    is_host: true,
    host_type: 'host'
  }).select('id, username, email').single();

  if (createErr) {
    if (createErr.code === '23505') return res.status(400).json({ error: 'Email already registered — update the existing account instead' });
    return res.status(500).json({ error: createErr.message });
  }

  hostSet.add(newUser.id);

  await supabaseAdmin.from('host_applications').update({
    status: 'approved',
    user_id: newUser.id,
    reviewed_at: new Date().toISOString(),
    reviewed_by: req.user.id
  }).eq('id', req.params.id);

  // Create monthly fee record due next 1st
  const nextDue = new Date();
  nextDue.setDate(1);
  nextDue.setMonth(nextDue.getMonth() + 1);
  await supabaseAdmin.from('monthly_fees').insert({
    user_id: newUser.id,
    username: newUser.username,
    role_type: 'host',
    fee_amount: 20,
    next_due_date: nextDue.toISOString().slice(0, 10),
    is_overdue: false
  }).catch(() => {});

  try {
    const { sendHostApprovalEmail } = require('../mail');
    await sendHostApprovalEmail({ to: app.email, hostName: app.full_name, username, password, hostType: 'host' });
  } catch {}

  res.json({ ok: true, userId: newUser.id, username });
});

// Admin: reject host application
router.post('/admin/host-applications/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { notes } = req.body;
  const { error } = await supabaseAdmin.from('host_applications').update({
    status: 'rejected',
    notes: notes ? String(notes).slice(0, 500) : null,
    reviewed_at: new Date().toISOString(),
    reviewed_by: req.user.id
  }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Admin Account Creation ───────────────────────────────────────────────────

// Admin creates another admin account with full requirements
router.post('/admin/create-admin', authMiddleware, adminMiddleware, async (req, res) => {
  const { full_name, phone, email, address, username, password, government_id_data, government_id_filename, monthly_fee_agreed, rake_agreed } = req.body;
  if (!full_name)          return res.status(400).json({ error: 'Full legal name is required' });
  if (!phone)              return res.status(400).json({ error: 'Phone is required' });
  if (!email)              return res.status(400).json({ error: 'Email is required' });
  if (!address)            return res.status(400).json({ error: 'Address is required' });
  if (!username)           return res.status(400).json({ error: 'Username is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password required (min 6 characters)' });
  if (!government_id_data) return res.status(400).json({ error: 'Government ID photo is required' });
  if (!monthly_fee_agreed) return res.status(400).json({ error: 'Must agree to the $40/month fee' });
  if (!rake_agreed)        return res.status(400).json({ error: 'Must agree to 20% rake contribution' });

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: newUser, error } = await supabaseAdmin.from('users').insert({
    username: String(username).slice(0, 30),
    email: String(email).slice(0, 255),
    password_hash: passwordHash,
    chips: 100000,
    full_name: String(full_name).slice(0, 120),
    phone: String(phone).slice(0, 20),
    address: String(address).slice(0, 500),
    is_admin: true,
    host_type: 'admin'
  }).select('id, username, email').single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
    return res.status(500).json({ error: error.message });
  }

  // Store application record for audit trail
  await supabaseAdmin.from('host_applications').insert({
    full_name: String(full_name).slice(0, 120),
    phone: String(phone).slice(0, 20),
    email: String(email).slice(0, 255),
    address: String(address).slice(0, 500),
    government_id_data: String(government_id_data),
    government_id_filename: government_id_filename ? String(government_id_filename).slice(0, 255) : null,
    monthly_fee_agreed: !!monthly_fee_agreed,
    rake_agreed: !!rake_agreed,
    status: 'approved',
    user_id: newUser.id,
    reviewed_at: new Date().toISOString(),
    reviewed_by: req.user.id
  }).catch(() => {});

  const nextDue = new Date();
  nextDue.setDate(1);
  nextDue.setMonth(nextDue.getMonth() + 1);
  await supabaseAdmin.from('monthly_fees').insert({
    user_id: newUser.id,
    username: newUser.username,
    role_type: 'admin',
    fee_amount: 40,
    next_due_date: nextDue.toISOString().slice(0, 10),
    is_overdue: false
  }).catch(() => {});

  res.json({ ok: true, userId: newUser.id, username: newUser.username });
});

// ─── Monthly Fees ─────────────────────────────────────────────────────────────

router.get('/admin/monthly-fees', authMiddleware, adminMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  await supabaseAdmin.from('monthly_fees')
    .update({ is_overdue: true, updated_at: new Date().toISOString() })
    .lt('next_due_date', today)
    .catch(() => {});

  const { data, error } = await supabaseAdmin.from('monthly_fees')
    .select('*')
    .order('role_type', { ascending: false })
    .order('username');
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with nickname from users table
  if (data?.length) {
    const userIds = [...new Set(data.map(r => r.user_id))];
    const { data: users } = await supabaseAdmin.from('users')
      .select('id, nickname, phone').in('id', userIds).catch(() => ({ data: [] }));
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });
    data.forEach(r => { r.nickname = userMap[r.user_id]?.nickname || null; r.phone = userMap[r.user_id]?.phone || null; });
  }

  res.json(data || []);
});

// Must be defined BEFORE the /:userId route to avoid path collision
router.post('/admin/monthly-fees/send-reminders', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { runDailyFeeCheck } = require('../fees');
    await runDailyFeeCheck();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/monthly-fees/:userId/mark-paid', authMiddleware, adminMiddleware, async (req, res) => {
  const { payment_method, notes } = req.body;
  const userId = req.params.userId;

  const nextDue = new Date();
  nextDue.setDate(1);
  nextDue.setMonth(nextDue.getMonth() + 1);

  const { data: fee } = await supabaseAdmin.from('monthly_fees')
    .select('username, role_type, fee_amount')
    .eq('user_id', userId)
    .single();

  const { error } = await supabaseAdmin.from('monthly_fees').update({
    last_paid_at: new Date().toISOString(),
    next_due_date: nextDue.toISOString().slice(0, 10),
    is_overdue: false,
    fee_suspended: false,
    suspended_at: null,
    payment_method: payment_method || null,
    payment_notes: notes || null,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });

  // Restore user access if suspended
  await supabaseAdmin.from('users').update({ fee_suspended: false }).eq('id', userId).catch(() => {});

  // Remove from in-memory suspended set
  try { const { feeSuspendedUsers } = require('../fees'); feeSuspendedUsers.delete(userId); } catch {}

  // Record payment in history table
  if (fee) {
    const forMonth = new Date(); forMonth.setDate(1);
    await supabaseAdmin.from('monthly_fee_payments').insert({
      user_id: userId,
      username: fee.username,
      role_type: fee.role_type,
      amount: fee.fee_amount,
      for_month: forMonth.toISOString().slice(0, 10),
      payment_method: payment_method || null,
      notes: notes || null
    }).catch(() => {});
  }

  res.json({ ok: true });
});

router.get('/admin/fee-income', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data: payments } = await supabaseAdmin.from('monthly_fee_payments')
      .select('amount, created_at');
    const all = payments || [];
    const total = all.reduce((s, p) => s + (p.amount || 0), 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTotal = all
      .filter(p => new Date(p.created_at) >= monthStart)
      .reduce((s, p) => s + (p.amount || 0), 0);

    const { data: overdueRows } = await supabaseAdmin.from('monthly_fees')
      .select('id', { count: 'exact' }).eq('is_overdue', true);

    res.json({ total, monthTotal, unpaidCount: (overdueRows || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rake Splits ──────────────────────────────────────────────────────────────

router.get('/admin/rake-splits', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('table_rake_splits')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });

  // Summarize total earnings per host
  const byHost = {};
  for (const r of (data || [])) {
    if (!r.host_id) continue;
    if (!byHost[r.host_id]) {
      byHost[r.host_id] = { host_id: r.host_id, host_username: r.host_username, host_type: r.host_type, total_earned: 0, sessions: 0 };
    }
    byHost[r.host_id].total_earned += r.host_amount;
    byHost[r.host_id].sessions++;
  }

  res.json({ splits: data || [], byHost: Object.values(byHost).sort((a, b) => b.total_earned - a.total_earned) });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────

// GET /api/leaderboard?by=total_won  (by = total_won | biggest_pot | sessions_played | win_rate)
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const by = req.query.by || 'total_won';
    const validColumns = ['total_won', 'biggest_pot', 'sessions_played', 'hands_won'];
    const orderCol = validColumns.includes(by) ? by : 'total_won';

    const { data, error } = await supabaseAdmin
      .from('player_stats')
      .select('user_id, username, hands_played, hands_won, total_won, total_lost, biggest_pot, favorite_hand, sessions_played, last_hand_at')
      .order(orderCol, { ascending: false })
      .limit(10);

    if (error) throw error;

    // Compute win_rate
    const rows = (data || []).map((r, i) => ({
      rank: i + 1,
      ...r,
      win_rate: r.hands_played > 0 ? Math.round((r.hands_won / r.hands_played) * 100) : 0
    }));

    res.json({ leaderboard: rows });
  } catch (err) {
    console.error('[leaderboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/players/:id/stats
router.get('/players/:id/stats', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;
    // Only allow viewing own stats unless admin
    if (targetId !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { data, error } = await supabaseAdmin
      .from('player_stats')
      .select('*')
      .eq('user_id', targetId)
      .single();

    if (error || !data) return res.json({ stats: null });
    const stats = {
      ...data,
      win_rate: data.hands_played > 0 ? Math.round((data.hands_won / data.hands_played) * 100) : 0
    };
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/leaderboard/reset  (admin only — wipes player_stats)
router.post('/admin/leaderboard/reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await supabaseAdmin.from('player_stats').delete().neq('user_id', '00000000-0000-0000-0000-000000000000');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Financial Dashboard ──────────────────────────────────────────────────────

router.get('/admin/financial-summary', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const todayStr   = now.toISOString().slice(0, 10);
    const weekAgo    = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStr    = weekAgo.toISOString().slice(0, 10);
    const monthStr   = monthStart.toISOString().slice(0, 10);

    const { data: reports } = await supabaseAdmin.from('session_reports')
      .select('session_date, total_rake, host_amount, house_amount, table_name, created_at')
      .order('session_date', { ascending: false });
    const allReports = reports || [];

    const sum   = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);
    const since = (arr, d) => arr.filter(r => ((r.session_date || r.created_at?.slice(0,10)) || '') >= d);

    const rakeAllTime    = sum(allReports, 'total_rake');
    const rakeThisMonth  = sum(since(allReports, monthStr),  'total_rake');
    const rakeThisWeek   = sum(since(allReports, weekStr),   'total_rake');
    const rakeToday      = sum(since(allReports, todayStr),  'total_rake');
    const hostCutsAll    = sum(allReports, 'host_amount');
    const hostCutsMonth  = sum(since(allReports, monthStr),  'host_amount');
    const houseAll       = sum(allReports, 'house_amount');
    const houseMonth     = sum(since(allReports, monthStr),  'house_amount');

    // Rake by day — last 60 days
    const sixtyAgo = new Date(now); sixtyAgo.setDate(sixtyAgo.getDate() - 59);
    const sixtyStr = sixtyAgo.toISOString().slice(0, 10);
    const byDayMap = {};
    since(allReports, sixtyStr).forEach(r => {
      const d = r.session_date || r.created_at?.slice(0, 10);
      if (d) byDayMap[d] = (byDayMap[d] || 0) + (r.total_rake || 0);
    });
    const byDay = [];
    for (let i = 59; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      byDay.push({ date: ds, amount: byDayMap[ds] || 0 });
    }

    // Top tables all-time
    const tableMap = {};
    allReports.forEach(r => {
      const n = r.table_name || 'Unknown';
      if (!tableMap[n]) tableMap[n] = { tableName: n, total: 0, sessions: 0 };
      tableMap[n].total += r.total_rake || 0;
      tableMap[n].sessions++;
    });
    const topTables = Object.values(tableMap).sort((a, b) => b.total - a.total).slice(0, 10);

    // Fee income
    const { data: feeRows } = await supabaseAdmin.from('monthly_fee_payments')
      .select('amount, created_at').catch(() => ({ data: [] }));
    const allFees    = feeRows || [];
    const feeAll     = sum(allFees, 'amount');
    const feeMonth   = allFees.filter(f => f.created_at >= monthStart.toISOString()).reduce((s, f) => s + (f.amount || 0), 0);

    // Top players by buy-in volume
    const { data: txData } = await supabaseAdmin.from('transactions')
      .select('username, amount').eq('type', 'buy_in').catch(() => ({ data: [] }));
    const playerMap = {};
    (txData || []).forEach(t => { playerMap[t.username] = (playerMap[t.username] || 0) + (t.amount || 0); });
    const topPlayers = Object.entries(playerMap)
      .map(([username, total]) => ({ username, total }))
      .sort((a, b) => b.total - a.total).slice(0, 10);

    res.json({
      rake:        { allTime: rakeAllTime, thisMonth: rakeThisMonth, thisWeek: rakeThisWeek, today: rakeToday, byDay, topTables },
      hostCuts:    { allTime: hostCutsAll,  thisMonth: hostCutsMonth },
      house:       { allTime: houseAll,     thisMonth: houseMonth },
      fees:        { allTime: feeAll,       thisMonth: feeMonth },
      netEarnings: { allTime: houseAll + feeAll, thisMonth: houseMonth + feeMonth },
      topPlayers
    });
  } catch (e) {
    console.error('[financial-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── CSV Exports ──────────────────────────────────────────────────────────────

function _csvRow(fields) {
  return fields.map(f => {
    const s = String(f == null ? '' : f);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

function _csvRange(req) {
  const from = req.query.from || '2020-01-01';
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);
  return { from, to };
}

function _sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.join('\r\n'));
}

router.get('/admin/export/players.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('users')
    .select('id, username, full_name, nickname, phone, email, address, city, state, zip, is_admin, is_host, host_type, created_at')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const { data: txData } = await supabaseAdmin.from('transactions')
    .select('user_id, type, amount').catch(() => ({ data: [] }));
  const buyIns = {}, cashOuts = {};
  (txData || []).forEach(t => {
    if (t.type === 'buy_in')   buyIns[t.user_id]   = (buyIns[t.user_id]   || 0) + (t.amount || 0);
    if (t.type === 'cash_out') cashOuts[t.user_id] = (cashOuts[t.user_id] || 0) + (t.amount || 0);
  });

  const rows = [
    _csvRow(['Username','Full Name','Nickname','Phone','Email','Address','City','State','ZIP','Role','Join Date','Total Buy-Ins','Total Cash-Outs','Net']),
    ...(data || []).map(p => {
      const bi = buyIns[p.id] || 0, co = cashOuts[p.id] || 0;
      const role = p.is_admin ? 'Admin' : p.is_host ? 'Host' : 'Player';
      return _csvRow([p.username, p.full_name||'', p.nickname||'', p.phone||'', p.email||'',
        p.address||'', p.city||'', p.state||'', p.zip||'', role, p.created_at?.slice(0,10)||'', bi, co, co-bi]);
    })
  ];
  _sendCsv(res, `players_${from}_${to}.csv`, rows);
});

router.get('/admin/export/session-reports.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('session_reports')
    .select('table_name, session_date, total_rake, pot_volume, hands_played, host_username, host_type, host_percent, host_amount, house_amount, created_at')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const rows = [
    _csvRow(['Table','Session Date','Total Rake','Pot Volume','Hands','Host','Host Type','Host %','Host Amount','House Amount','Created At']),
    ...(data || []).map(r => _csvRow([r.table_name, r.session_date, r.total_rake, r.pot_volume, r.hands_played,
      r.host_username||'', r.host_type||'', r.host_percent, r.host_amount, r.house_amount, r.created_at?.slice(0,10)]))
  ];
  _sendCsv(res, `session_reports_${from}_${to}.csv`, rows);
});

router.get('/admin/export/rake-report.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('hands')
    .select('table_id, rake_collected, jackpot_contribution, started_at')
    .eq('status', 'completed')
    .gte('started_at', from + 'T00:00:00Z')
    .lte('started_at', to   + 'T23:59:59Z')
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const rows = [
    _csvRow(['Date','Table ID','Rake Collected','Jackpot Contribution']),
    ...(data || []).map(h => _csvRow([h.started_at?.slice(0,10), h.table_id||'', h.rake_collected, h.jackpot_contribution]))
  ];
  _sendCsv(res, `rake_report_${from}_${to}.csv`, rows);
});

router.get('/admin/export/transactions.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('transactions')
    .select('created_at, username, type, amount, table_name, payment_method, notes')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) {
    if (/does not exist|relation/.test(error.message)) return _sendCsv(res, 'transactions_empty.csv', [_csvRow(['No Data — run migration 008'])]);
    return res.status(500).json({ error: error.message });
  }
  const rows = [
    _csvRow(['Date','Username','Type','Amount','Table','Payment Method','Notes']),
    ...(data || []).map(t => _csvRow([t.created_at?.slice(0,10), t.username||'', t.type, t.amount||0, t.table_name||'', t.payment_method||'', t.notes||'']))
  ];
  _sendCsv(res, `transactions_${from}_${to}.csv`, rows);
});

router.get('/admin/export/fee-payments.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('monthly_fee_payments')
    .select('created_at, username, role_type, amount, for_month, payment_method, notes')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const rows = [
    _csvRow(['Date','Username','Role','Amount','For Month','Payment Method','Notes']),
    ...(data || []).map(f => _csvRow([f.created_at?.slice(0,10), f.username||'', f.role_type||'', f.amount||0, f.for_month||'', f.payment_method||'', f.notes||'']))
  ];
  _sendCsv(res, `fee_payments_${from}_${to}.csv`, rows);
});

// ─── Weekly Financial Summary Email ───────────────────────────────────────────

router.post('/admin/send-weekly-summary', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const weekAgo  = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const fromStr  = weekAgo.toISOString().slice(0, 10);
    const toStr    = now.toISOString().slice(0, 10);

    const { data: reports } = await supabaseAdmin.from('session_reports')
      .select('total_rake, host_amount, house_amount, table_name, session_date')
      .gte('session_date', fromStr);
    const allR = reports || [];
    const totalRake      = allR.reduce((s, r) => s + (r.total_rake   || 0), 0);
    const hostCuts       = allR.reduce((s, r) => s + (r.host_amount  || 0), 0);
    const houseRake      = allR.reduce((s, r) => s + (r.house_amount || 0), 0);

    const { data: feeData } = await supabaseAdmin.from('monthly_fee_payments')
      .select('amount, username').gte('created_at', weekAgo.toISOString()).catch(() => ({ data: [] }));
    const feesCollected = (feeData || []).reduce((s, f) => s + (f.amount || 0), 0);

    const tableMap = {};
    allR.forEach(r => {
      const n = r.table_name || 'Unknown';
      if (!tableMap[n]) tableMap[n] = { total: 0, sessions: 0 };
      tableMap[n].total += r.total_rake || 0;
      tableMap[n].sessions++;
    });

    const { sendWeeklySummaryEmail } = require('../mail');
    await sendWeeklySummaryEmail({
      from: fromStr, to: toStr, sessions: allR.length,
      totalRake, hostCuts, houseRake, feesCollected,
      netEarnings: houseRake + feesCollected,
      tableMap, feePayments: feeData || []
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[weekly-summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
