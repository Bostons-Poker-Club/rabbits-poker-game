'use strict';

const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { supabaseAdmin } = require('../db/supabase');
const appEvents  = require('../events');
const { logTransaction } = require('../transactions');
const { send2FACode, sendPlayerEmail } = require('../mail');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ─── 2FA in-memory store ───────────────────────────────────────────────────────
// Keyed by userId; entries expire after 5 minutes and are pruned on lookup.
const pending2FA = new Map(); // userId -> { code, expiresAt, attempts, username, email, phone }

function _gen2FACode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function _genBackupCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0,4)}-${raw.slice(4,8)}`;
  });
}

async function _hashBackupCodes(codes) {
  return Promise.all(codes.map(c => bcrypt.hash(c, 10).then(hash => ({ hash, used: false }))));
}

// Purge expired pending entries (called on each verify attempt)
function _prunePending2FA() {
  const now = Date.now();
  for (const [uid, entry] of pending2FA) {
    if (entry.expiresAt < now) pending2FA.delete(uid);
  }
}

// ─── Password-reset cooldown ──────────────────────────────────────────────────
// Prevents runaway loops (browser network retries, admin double-clicks) from
// overwriting a user's password hash multiple times in quick succession.
// Map: userId → timestamp of last successful hash write.
const _pwResetCooldown = new Map(); // userId -> lastResetAt (ms)
const PW_RESET_COOLDOWN_MS = 90_000; // 90 seconds

function _checkResetCooldown(userId) {
  const last = _pwResetCooldown.get(userId);
  if (last && Date.now() - last < PW_RESET_COOLDOWN_MS) return false; // still cooling down
  return true; // ok to proceed
}

function _markResetCooldown(userId) {
  _pwResetCooldown.set(userId, Date.now());
  // Auto-clean after TTL to avoid unbounded memory growth
  setTimeout(() => _pwResetCooldown.delete(userId), PW_RESET_COOLDOWN_MS + 5000);
}

// ─── Login rate limiter ────────────────────────────────────────────────────────
// Counts only failed attempts (skipSuccessfulRequests). Blocks after 10 failures.
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    const ms = req.rateLimit?.resetTime ? req.rateLimit.resetTime - Date.now() : 30 * 60 * 1000;
    const mins = Math.max(1, Math.ceil(ms / 60000));
    res.status(429).json({
      error: `Too many attempts. Please wait ${mins} minute${mins !== 1 ? 's' : ''} or contact admin at bostonspokerclub.amitureflops@gmail.com or text ${process.env.ADMIN_PHONE || '(857) 230-8682'}`
    });
  },
});

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

router.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password, deviceId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const ip        = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 400);

  async function _audit(userId, success, reason) {
    try {
      await supabaseAdmin.from('login_audit').insert({
        user_id: userId || null,
        username: String(username).slice(0, 50),
        ip_address: ip,
        user_agent: userAgent,
        success,
        failure_reason: reason || null
      });
    } catch {}
  }

  try {
  // Try Supabase first
  const { data: user, error: dbError } = await supabaseAdmin
    .from('users').select('*').eq('username', username).single();

  console.log(`[login] user=${username} db_found=${!!user} db_error=${dbError?.code || 'none'}`);

  if (user) {
    if (user.is_banned) {
      await _audit(user.id, false, 'account_banned');
      return res.status(403).json({ error: 'Your account has been suspended. Contact admin at bostonspokerclub.amitureflops@gmail.com' });
    }

    // Check 2FA lockout
    if (user.two_fa_locked_until && new Date(user.two_fa_locked_until) > new Date()) {
      const unlockMins = Math.ceil((new Date(user.two_fa_locked_until) - Date.now()) / 60000);
      await _audit(user.id, false, '2fa_locked');
      return res.status(403).json({ error: `Account locked due to too many failed verification attempts. Try again in ${unlockMins} minute${unlockMins !== 1 ? 's' : ''}.` });
    }

    // Trim whitespace — email clients sometimes wrap or pad copied passwords
    const passwordTrimmed = password.trim();
    if (user.must_change_password) {
      console.log(`[login] temp-password login for ${username} | input_len=${passwordTrimmed.length} | hash_exists=${!!user.password_hash}`);
    }
    const valid = await bcrypt.compare(passwordTrimmed, user.password_hash);
    console.log(`[login] db bcrypt valid=${valid} | user=${username} | temp=${!!user.must_change_password}`);
    if (!valid) {
      await _audit(user.id, false, 'wrong_password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Determine if 2FA is required (admin or host, with 2FA not disabled)
    const needs2FA = (user.is_admin || user.is_host) && user.two_fa_enabled !== false;

    if (needs2FA) {
      // Check trusted device
      const devices = Array.isArray(user.two_fa_trusted_devices) ? user.two_fa_trusted_devices : [];
      const now = Date.now();
      const trusted = deviceId && devices.some(d => d.id === deviceId && new Date(d.expiresAt).getTime() > now);

      if (!trusted) {
        // Ensure backup codes exist (lazy generation on first 2FA challenge)
        if (!Array.isArray(user.two_fa_backup_codes) || user.two_fa_backup_codes.length === 0) {
          const raw = _genBackupCodes();
          const hashed = await _hashBackupCodes(raw);
          await supabaseAdmin.from('users').update({ two_fa_backup_codes: hashed }).eq('id', user.id);
          // We don't expose raw codes here — admin downloads them later
        }

        const code = _gen2FACode();
        pending2FA.set(user.id, {
          code, expiresAt: Date.now() + 5 * 60 * 1000,
          attempts: 0, username: user.username, email: user.email, phone: user.phone
        });

        // Send code (fire-and-forget)
        send2FACode({ to: user.email, phone: user.phone, username: user.username, code }).catch(console.warn);

        // Issue short-lived pending token
        const pendingToken = jwt.sign({ id: user.id, type: 'pending_2fa' }, JWT_SECRET, { expiresIn: '5m' });
        await _audit(user.id, false, '2fa_required');
        const backupCodesLeft = (user.two_fa_backup_codes || []).filter(c => !c.used).length;
        return res.json({
          requires2fa: true,
          pendingToken,
          hint: `Code sent to ${user.email ? user.email.replace(/(.{2}).+(@.+)/, '$1…$2') : ''}${user.phone ? ' and phone' : ''}`,
          backupCodesLeft
        });
      }
    }

    await _audit(user.id, true, null);
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    const mustChange = user.must_change_password === true;
    return res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips, isAdmin: user.is_admin }, mustChangePassword: mustChange || undefined });
  }

  // Supabase unavailable or user not found — fall back to local admin bypass
  if (username === LOCAL_ADMIN.username) {
    const valid = await bcrypt.compare(password, LOCAL_ADMIN.passwordHash);
    console.log(`[login] local bypass bcrypt valid=${valid}`);
    if (!valid) {
      await _audit(LOCAL_ADMIN.id, false, 'wrong_password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await _audit(LOCAL_ADMIN.id, true, null);
    const token = jwt.sign({ id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, isAdmin: true }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: LOCAL_ADMIN.id, username: LOCAL_ADMIN.username, email: LOCAL_ADMIN.email, chips: LOCAL_ADMIN.chips, isAdmin: true } });
  }

  await _audit(null, false, 'user_not_found');
  return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) {
    console.error('[login] unhandled error:', err.message);
    return res.status(503).json({ error: 'Login service temporarily unavailable. Please try again.' });
  }
});

// ─── 2FA Verify ────────────────────────────────────────────────────────────────
router.post('/auth/2fa/verify', async (req, res) => {
  const { pendingToken, code, rememberDevice, deviceId } = req.body;
  if (!pendingToken || !code) return res.status(400).json({ error: 'Missing token or code' });

  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Verification session expired. Please log in again.' });
  }
  if (payload.type !== 'pending_2fa') return res.status(401).json({ error: 'Invalid token type' });

  try {

  const userId = payload.id;
  _prunePending2FA();

  const pending = pending2FA.get(userId);

  // Fetch user for lockout check, backup codes, and final token issuance
  const { data: user } = await supabaseAdmin.from('users').select('*').eq('id', userId).single();
  if (!user) return res.status(401).json({ error: 'User not found' });

  // Check lockout (may have been set by a previous attempt)
  if (user.two_fa_locked_until && new Date(user.two_fa_locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.two_fa_locked_until) - Date.now()) / 60000);
    return res.status(403).json({ error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
  }

  const inputCode = String(code).trim().replace(/\s/g, '');

  // ── Try backup code first ─────────────────────────────────────────────────
  if (inputCode.includes('-') || inputCode.length === 8) {
    const backupCodes = Array.isArray(user.two_fa_backup_codes) ? user.two_fa_backup_codes : [];
    let matched = -1;
    for (let i = 0; i < backupCodes.length; i++) {
      if (backupCodes[i].used) continue;
      const ok = await bcrypt.compare(inputCode.toUpperCase(), backupCodes[i].hash);
      if (ok) { matched = i; break; }
    }
    if (matched === -1) {
      return res.status(401).json({ error: 'Invalid backup code.' });
    }
    // Mark backup code as used
    backupCodes[matched].used = true;
    await supabaseAdmin.from('users').update({ two_fa_backup_codes: backupCodes }).eq('id', userId);
    pending2FA.delete(userId);
    const remaining = backupCodes.filter(c => !c.used).length;
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips, isAdmin: user.is_admin }, backupCodesLeft: remaining });
  }

  // ── Try TOTP code ─────────────────────────────────────────────────────────
  if (!pending || pending.expiresAt < Date.now()) {
    pending2FA.delete(userId);
    return res.status(401).json({ error: 'Code has expired. Please log in again.' });
  }

  if (inputCode !== pending.code) {
    pending.attempts += 1;
    if (pending.attempts >= 3) {
      pending2FA.delete(userId);
      const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await supabaseAdmin.from('users').update({ two_fa_locked_until: lockUntil }).eq('id', userId);
      return res.status(403).json({ error: 'Too many incorrect attempts. Account locked for 15 minutes.' });
    }
    return res.status(401).json({ error: `Invalid code. ${3 - pending.attempts} attempt${3 - pending.attempts !== 1 ? 's' : ''} remaining.` });
  }

  // ── Code correct — complete login ─────────────────────────────────────────
  pending2FA.delete(userId);

  const updates = { two_fa_locked_until: null };

  if (rememberDevice && deviceId) {
    const devices = Array.isArray(user.two_fa_trusted_devices) ? user.two_fa_trusted_devices : [];
    // Remove expired devices and any existing entry for this deviceId
    const now = Date.now();
    const cleaned = devices.filter(d => new Date(d.expiresAt).getTime() > now && d.id !== deviceId);
    cleaned.push({ id: deviceId, expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString() });
    updates.two_fa_trusted_devices = cleaned;
  }

  await supabaseAdmin.from('users').update(updates).eq('id', userId);
  try {
    await supabaseAdmin.from('login_audit').insert({
      user_id: userId, username: user.username,
      ip_address: req.ip || 'unknown', user_agent: String(req.headers['user-agent'] || '').slice(0, 400),
      success: true, failure_reason: null
    });
  } catch {}

  const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  const backupCodesLeft = (user.two_fa_backup_codes || []).filter(c => !c.used).length;
  return res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips, isAdmin: user.is_admin }, backupCodesLeft });
  } catch (err) {
    console.error('[2fa/verify] unhandled error:', err.message);
    return res.status(503).json({ error: 'Verification service temporarily unavailable. Please try again.' });
  }
});

router.post('/auth/forgot-password', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Username or email required' });

  let user = null;
  try {
    const idClean = String(identifier).trim().toLowerCase();
    const { data: byEmail } = await supabaseAdmin.from('users')
      .select('id, username, email').eq('email', idClean).maybeSingle();
    if (byEmail) {
      user = byEmail;
    } else {
      const { data: byUser } = await supabaseAdmin.from('users')
        .select('id, username, email').ilike('username', identifier.trim()).maybeSingle();
      user = byUser;
    }
  } catch {}

  // Always return ok — never reveal whether account exists
  if (!user?.email) return res.json({ ok: true });

  // Cooldown: if this user's password was reset within the last 90 seconds,
  // return ok silently — the first temp password is still valid and in use.
  if (!_checkResetCooldown(user.id)) {
    console.log(`[forgot-password] Cooldown active for ${user.username} — skipping duplicate reset`);
    return res.json({ ok: true });
  }

  // Lowercase hex — no uppercase/case confusion when typing from email
  const tempPassword = crypto.randomBytes(4).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);
  const { error: updateErr } = await supabaseAdmin.from('users')
    .update({ password_hash: hash, must_change_password: true })
    .eq('id', user.id);
  if (updateErr) {
    console.error('[forgot-password] DB update error:', updateErr.message);
    return res.json({ ok: true }); // still return ok — don't reveal account existence
  }
  _markResetCooldown(user.id);
  console.log(`[forgot-password] Temp password set for ${user.username} (${user.email})`);

  try {
    await sendPlayerEmail({
      to: user.email,
      subject: 'Your temporary password — Boston Poker Club',
      text: `Hi ${user.username},\n\nYour temporary password is: ${tempPassword}\n\nType it exactly as shown (all lowercase). Log in at rabbsroom.com and you will be prompted to set a new password.\n\n— Boston Poker Club`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a7a3f">🔑 Temporary Password</h2>
        <p>Hi <strong>${user.username}</strong>,</p>
        <p>Here is your temporary password:</p>
        <div style="font-family:monospace;font-size:1.8rem;font-weight:700;letter-spacing:.12em;color:#1a5c2a;background:#f0faf5;border:2px solid #b2dfcc;border-radius:10px;padding:14px 20px;text-align:center;margin:16px 0">${tempPassword}</div>
        <p style="color:#555;font-size:.9rem"><strong>Type it exactly as shown</strong> — all lowercase letters and numbers.</p>
        <p style="color:#666;font-size:.88rem">Log in at <a href="https://rabbsroom.com" style="color:#1a7a3f">rabbsroom.com</a> and you will be prompted to set a permanent password immediately.</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
      </div>`
    });
  } catch (e) {
    console.error('[forgot-password] Email send error:', e.message);
  }

  res.json({ ok: true });
});

// ─── 2FA Resend Code ───────────────────────────────────────────────────────────
router.post('/auth/2fa/resend', async (req, res) => {
  const { pendingToken } = req.body;
  if (!pendingToken) return res.status(400).json({ error: 'Missing token' });
  let payload;
  try { payload = jwt.verify(pendingToken, JWT_SECRET); } catch { return res.status(401).json({ error: 'Session expired. Please log in again.' }); }
  if (payload.type !== 'pending_2fa') return res.status(401).json({ error: 'Invalid token' });

  const userId = payload.id;
  const existing = pending2FA.get(userId);
  if (!existing) return res.status(400).json({ error: 'No pending verification. Please log in again.' });

  const code = _gen2FACode();
  existing.code = code;
  existing.expiresAt = Date.now() + 5 * 60 * 1000;
  existing.attempts = 0;

  send2FACode({ to: existing.email, phone: existing.phone, username: existing.username, code }).catch(console.warn);
  res.json({ ok: true, hint: `Code resent to ${existing.email ? existing.email.replace(/(.{2}).+(@.+)/, '$1…$2') : 'your phone'}` });
});

// ─── Health / Diagnostics ───────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  const hasDb  = !!process.env.DATABASE_URL;
  const hasJwt = !!process.env.JWT_SECRET && process.env.JWT_SECRET !== 'dev-secret-change-me';

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
    db: dbStatus,
    userCount,
    hasDatabaseUrl: hasDb,
    hasJwt,
    nodeVersion: process.version
  });
});

// ─── Profile ────────────────────────────────────────────────────────────────

router.get('/profile', authMiddleware, async (req, res) => {
  let data, error;
  ({ data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_host, avatar_url, nickname, created_at')
    .eq('id', req.user.id)
    .single());
  // Retry with base columns if extended columns don't exist yet
  if (!data) {
    console.warn(`[profile] Extended select failed (${error?.message}), retrying base columns for ${req.user.id}`);
    ({ data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, email, chips, is_admin, created_at')
      .eq('id', req.user.id)
      .single());
  }
  if (!data) {
    console.error(`[profile] User ${req.user.id} not found: ${error?.message}`);
    return res.status(404).json({ error: 'User not found' });
  }

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

const VALID_FELT_COLORS = ['#1a5c2a', '#0a1628', '#4a0a0a', '#2a0a4a', '#0a0a0a', '#0a3a3a'];

router.post('/tables', authMiddleware, hostMiddleware, async (req, res) => {
  const { name, game_type, stakes_small_blind, stakes_big_blind, max_players, rake_percent, felt_color } = req.body;
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
      host_id: req.user.id,
      felt_color: VALID_FELT_COLORS.includes(felt_color) ? felt_color : '#1a5c2a'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/admin/tables/:id/felt-color', authMiddleware, adminMiddleware, async (req, res) => {
  const { felt_color } = req.body;
  if (!VALID_FELT_COLORS.includes(felt_color)) return res.status(400).json({ error: 'Invalid felt color' });
  const { error } = await supabaseAdmin.from('tables').update({ felt_color }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
        const { data: hostUser } = await supabaseAdmin.from('users').select('username, email, is_admin, is_host').eq('id', hostId).single();
        if (hostUser) {
          hostUsername = hostUser.username;
          hostType     = hostUser.is_admin ? 'admin' : (hostUser.is_host ? 'host' : 'host');
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
  // Tear down in-memory game state so the table vanishes immediately for all clients
  appEvents.emit('table:closed', { tableId });
  res.json({ success: true });
});

// ─── Tournaments ─────────────────────────────────────────────────────────────

router.get('/tournaments', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tournaments')
    .select('*, tournament_players(count)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Mark which tournaments the current user is already registered for
  const { data: myRegs } = await supabaseAdmin
    .from('tournament_players').select('tournament_id').eq('user_id', req.user.id);
  const regIds = new Set((myRegs || []).map(r => r.tournament_id));
  res.json((data || []).map(t => ({ ...t, is_registered: regIds.has(t.id) })));
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

router.delete('/tournaments/:id/register', authMiddleware, async (req, res) => {
  const { data: tournament } = await supabaseAdmin
    .from('tournaments').select('buy_in, status').eq('id', req.params.id).single();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  if (tournament.status !== 'registering') return res.status(400).json({ error: 'Cannot unregister — tournament already started' });

  const { error: delErr } = await supabaseAdmin
    .from('tournament_players')
    .delete()
    .eq('tournament_id', req.params.id)
    .eq('user_id', req.user.id);
  if (delErr) return res.status(500).json({ error: delErr.message });

  const { data: usr } = await supabaseAdmin.from('users').select('chips').eq('id', req.user.id).single();
  await supabaseAdmin.from('users').update({ chips: (usr?.chips || 0) + tournament.buy_in }).eq('id', req.user.id);

  res.json({ ok: true, refunded: tournament.buy_in });
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

// ─── Admin Tournament Player Management ──────────────────────────────────────

// Full player roster for a tournament (admin only)
router.get('/admin/tournaments/:id/players', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tournament_players')
    .select('id, user_id, chips, placement, is_eliminated, registered_at, buy_in_paid, prize_won, status, users(id, username, full_name, nickname, phone, email, chips)')
    .eq('tournament_id', req.params.id)
    .order('registered_at', { ascending: true });

  if (error) {
    // Graceful fallback if new columns not yet migrated
    const { data: fallback, error: fbErr } = await supabaseAdmin
      .from('tournament_players')
      .select('id, user_id, chips, placement, is_eliminated, registered_at, users(id, username, full_name, nickname, phone, email, chips)')
      .eq('tournament_id', req.params.id)
      .order('registered_at', { ascending: true });
    if (fbErr) return res.status(500).json({ error: fbErr.message });
    return res.json((fallback || []).map(p => ({ ...p, buy_in_paid: false, prize_won: 0, status: 'registered' })));
  }
  res.json(data || []);
});

// Admin manually registers a player to a tournament
router.post('/admin/tournaments/:id/players', authMiddleware, adminMiddleware, async (req, res) => {
  const { user_id, mark_paid } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const { data: tournament } = await supabaseAdmin
    .from('tournaments').select('id, name, buy_in, starting_chips, status').eq('id', req.params.id).single();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  const { data: userRow } = await supabaseAdmin
    .from('users').select('id, username, chips').eq('id', user_id).single();
  if (!userRow) return res.status(404).json({ error: 'Player not found' });

  // Check if already registered
  const { data: existing } = await supabaseAdmin
    .from('tournament_players')
    .select('id').eq('tournament_id', req.params.id).eq('user_id', user_id).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Player already registered' });

  const paid = !!mark_paid;

  const { data, error } = await supabaseAdmin
    .from('tournament_players')
    .insert({
      tournament_id: req.params.id,
      user_id,
      chips: tournament.starting_chips || 0,
      buy_in_paid: paid,
      status: 'registered'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Deduct buy-in chips if marking paid
  if (paid && tournament.buy_in > 0) {
    await supabaseAdmin
      .from('users')
      .update({ chips: Math.max(0, (userRow.chips || 0) - tournament.buy_in) })
      .eq('id', user_id);
  }

  res.json(data);
});

// Admin removes a player from a tournament
router.delete('/admin/tournaments/:id/players/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  const { data: tp } = await supabaseAdmin
    .from('tournament_players')
    .select('buy_in_paid')
    .eq('tournament_id', req.params.id)
    .eq('user_id', req.params.userId)
    .maybeSingle();

  const { error } = await supabaseAdmin
    .from('tournament_players')
    .delete()
    .eq('tournament_id', req.params.id)
    .eq('user_id', req.params.userId);

  if (error) return res.status(500).json({ error: error.message });

  // Refund buy-in if they had paid and tournament is still registering
  if (tp?.buy_in_paid) {
    const { data: tournament } = await supabaseAdmin
      .from('tournaments').select('buy_in, status').eq('id', req.params.id).single();
    if (tournament && tournament.status === 'registering') {
      const { data: userRow } = await supabaseAdmin.from('users').select('chips').eq('id', req.params.userId).single();
      if (userRow) {
        await supabaseAdmin.from('users')
          .update({ chips: (userRow.chips || 0) + (tournament.buy_in || 0) })
          .eq('id', req.params.userId);
      }
    }
  }

  res.json({ ok: true });
});

// Admin updates a tournament player (mark paid, update chips, status)
router.patch('/admin/tournaments/:id/players/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  const { buy_in_paid, chips, status, prize_won } = req.body;
  const updates = {};
  if (buy_in_paid !== undefined) updates.buy_in_paid = !!buy_in_paid;
  if (chips       !== undefined) updates.chips       = parseInt(chips) || 0;
  if (status      !== undefined) updates.status      = status;
  if (prize_won   !== undefined) updates.prize_won   = parseInt(prize_won) || 0;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const { error } = await supabaseAdmin
    .from('tournament_players')
    .update(updates)
    .eq('tournament_id', req.params.id)
    .eq('user_id', req.params.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
    if (!jp) return res.status(404).json({ error: 'No jackpot found for this table. Note: PLO tables do not support the High Hand Jackpot.' });

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

router.get('/admin/players/note-counts', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('player_notes').select('player_id');
  if (error) {
    if (/does not exist|relation/.test(error.message)) return res.json({});
    return res.status(500).json({ error: error.message });
  }
  const counts = {};
  for (const row of (data || [])) counts[row.player_id] = (counts[row.player_id] || 0) + 1;
  res.json(counts);
});

router.get('/admin/players', authMiddleware, adminMiddleware, async (req, res) => {
  // Try with extended profile columns; fall back to base columns if migration not yet applied
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone, address, city, state, zip, two_fa_enabled, two_fa_locked_until')
    .order('created_at', { ascending: false });

  if (error && (error.message?.includes('column') || error.message?.includes('does not exist'))) {
    ({ data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, email, chips, is_admin, is_banned, created_at')
      .order('created_at', { ascending: false }));
  }

  if (error) return res.status(500).json({ error: error.message });

  // Compute participation_type: cash | tournament | both | none
  try {
    const [{ data: tpRows }, { data: txRows }] = await Promise.all([
      supabaseAdmin.from('tournament_players').select('user_id'),
      supabaseAdmin.from('transactions').select('user_id').in('type', ['buy_in', 'cash_out', 'cashout'])
    ]);
    const tIds = new Set((tpRows || []).map(r => r.user_id));
    const cIds = new Set((txRows || []).map(r => r.user_id));
    const { userSockets } = require('../socket/handlers');
    res.json((data || []).map(p => ({
      ...p,
      is_host: hostSet.has(p.id),
      isOnline: userSockets.has(p.id),
      participation_type: tIds.has(p.id) && cIds.has(p.id) ? 'both'
                        : tIds.has(p.id) ? 'tournament'
                        : cIds.has(p.id) ? 'cash'
                        : 'none'
    })));
  } catch {
    const { userSockets } = require('../socket/handlers');
    res.json((data || []).map(p => ({ ...p, is_host: hostSet.has(p.id), isOnline: userSockets.has(p.id) })));
  }
});

router.get('/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone, address, city, state, zip, two_fa_enabled, two_fa_locked_until')
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
      newIsAdmin = true;
      roleChanged = true;
      hostSet.delete(targetId);
    } else if (role === 'host') {
      updates.is_admin = false;
      updates.is_host  = true;
      newIsAdmin = false;
      hostSet.add(targetId);
      roleChanged = true;
    } else {
      updates.is_admin = false;
      updates.is_host  = false;
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
    const missing = error.message.match(/column (?:[\w.]*\.)?["']?(\w+)["']? does not exist/) ||
                    error.message.match(/Could not find the '(\w+)' column of '\w+' in the schema cache/);
    if (missing) {
      const col = missing[1];
      console.warn(`[editPlayer] column "${col}" missing in users table — skipping`);
      delete remaining[col];
    } else {
      break;
    }
  }
  if (updateError) return res.status(500).json({ error: updateError.message });

  // Notify player's live socket if chips changed
  const chipsChanged = updates.chips !== undefined;
  if (chipsChanged) {
    const io = req.app.get('io');
    if (io) {
      const newChipsVal = updates.chips;
      const delta = newChipsVal - (current?.chips || 0);
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === targetId) {
          s.emit('chips_received', { amount: delta, from: 'Admin', newTotal: newChipsVal });
        }
      }
    }
  }

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
  // Evict from any live table before deleting the DB record so the in-memory
  // game state is cleared and chips are returned while the user row still exists.
  appEvents.emit('player:deleted', { userId: req.params.id });
  // Small delay to let the async eviction start before the user row is gone
  await new Promise(r => setTimeout(r, 150));
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

  // Notify player's live socket so their UI updates immediately
  const io = req.app.get('io');
  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === req.params.id) {
        s.emit('chips_received', { amount, from: 'Admin', newTotal: newChips });
      }
    }
  }

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
    try { await supabaseAdmin.from('users').update({ is_host: true }).eq('id', req.params.id); } catch (e) { console.warn('[host] update error:', e.message); }
  } else {
    hostSet.delete(req.params.id);
    try { await supabaseAdmin.from('users').update({ is_host: false }).eq('id', req.params.id); } catch (e) { console.warn('[host] update error:', e.message); }
  }
  appEvents.emit('host:change', { userId: req.params.id, isHost: !!isHost });
  res.json({ success: true, is_host: !!isHost });
});

router.get('/admin/maintenance', authMiddleware, adminMiddleware, (req, res) => {
  const maint = req.app.get('maintenance');
  res.json(maint ? maint.getState() : { active: false, message: '' });
});

router.post('/admin/maintenance', authMiddleware, adminMiddleware, (req, res) => {
  const maint = req.app.get('maintenance');
  if (!maint) return res.status(500).json({ error: 'Maintenance module not available' });
  const { active, message } = req.body;
  maint.setState(active, message);
  const state = maint.getState();
  // Push real-time update to all connected clients
  const io = req.app.get('io');
  if (io) io.emit('maintenance:update', state);
  console.log(`[maintenance] Banner ${state.active ? 'ENABLED' : 'DISABLED'} by ${req.user.username}`);
  res.json({ ok: true, ...state });
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
    updates.is_host   = false;
    hostSet.delete(req.params.id);
  }
  const { error } = await supabaseAdmin.from('users').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  const appEvents = require('../events');
  appEvents.emit('admin:change', { userId: req.params.id, isAdmin: !!makeAdmin });
  res.json({ success: true, is_admin: !!makeAdmin });
});

// ─── 2FA Admin Management ──────────────────────────────────────────────────────

router.post('/admin/players/:id/2fa/disable', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ two_fa_enabled: false, two_fa_locked_until: null, two_fa_trusted_devices: [] })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/admin/players/:id/2fa/enable', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ two_fa_enabled: true, two_fa_locked_until: null })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/admin/players/:id/2fa/unlock', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ two_fa_locked_until: null })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/admin/players/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: user } = await supabaseAdmin.from('users')
    .select('username, email').eq('id', id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.email) return res.status(400).json({ error: 'Player has no email on file' });

  // Cooldown: if this user's password was reset within the last 90 seconds,
  // return a clear error so the admin knows not to click again.
  if (!_checkResetCooldown(id)) {
    return res.status(429).json({ error: 'Password was just reset — wait 90 seconds before resetting again.' });
  }

  // Lowercase hex — no uppercase/case confusion when typing from email
  const tempPassword = crypto.randomBytes(4).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);
  const { error: updateErr } = await supabaseAdmin.from('users')
    .update({ password_hash: hash, must_change_password: true })
    .eq('id', id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });
  _markResetCooldown(id);
  console.log(`[admin reset-password] Temp password set for ${user.username} (${user.email})`);

  try {
    await sendPlayerEmail({
      to: user.email,
      subject: 'Your password has been reset — Boston Poker Club',
      text: `Hi ${user.username},\n\nAn admin has reset your password.\n\nTemporary password: ${tempPassword}\n\nType it exactly as shown (all lowercase). Log in at rabbsroom.com and you will be prompted to set a new password.\n\n— Boston Poker Club`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#c8a84b">🔑 Password Reset by Admin</h2>
        <p>Hi <strong>${user.username}</strong>,</p>
        <p>An admin has reset your account password.</p>
        <div style="font-family:monospace;font-size:1.8rem;font-weight:700;letter-spacing:.12em;color:#1a5c2a;background:#f0faf5;border:2px solid #b2dfcc;border-radius:10px;padding:14px 20px;text-align:center;margin:16px 0">${tempPassword}</div>
        <p style="color:#555;font-size:.9rem"><strong>Type it exactly as shown</strong> — all lowercase letters and numbers.</p>
        <p style="color:#666;font-size:.88rem">Log in at <a href="https://rabbsroom.com" style="color:#1a7a3f">rabbsroom.com</a> and you will be prompted to set a permanent password immediately.</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
      </div>`
    });
  } catch (e) {
    console.error('[admin reset-password] Email error:', e.message);
  }

  res.json({ ok: true, email: user.email });
});

router.get('/admin/players/:id/backup-codes', authMiddleware, adminMiddleware, async (req, res) => {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('username, two_fa_backup_codes')
    .eq('id', req.params.id)
    .single();
  if (error || !user) return res.status(404).json({ error: 'User not found' });
  const codes = (user.two_fa_backup_codes || []);
  res.json({ username: user.username, total: codes.length, remaining: codes.filter(c => !c.used).length });
});

router.post('/admin/players/:id/backup-codes/regenerate', authMiddleware, adminMiddleware, async (req, res) => {
  const rawCodes = _genBackupCodes();
  const hashed   = await _hashBackupCodes(rawCodes);
  const { error } = await supabaseAdmin.from('users').update({ two_fa_backup_codes: hashed }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ codes: rawCodes }); // Return plaintext once for download
});

router.get('/admin/players/:id/backup-codes/download', authMiddleware, adminMiddleware, async (req, res) => {
  const { data: user } = await supabaseAdmin.from('users').select('username, two_fa_backup_codes').eq('id', req.params.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Only expose remaining count; plaintext codes are only available at generation time
  const codes = (user.two_fa_backup_codes || []);
  const remaining = codes.filter(c => !c.used).length;
  res.json({ username: user.username, remaining, note: 'Plaintext backup codes are only available immediately after regeneration.' });
});

router.get('/admin/hosts', authMiddleware, adminMiddleware, async (req, res) => {
  const hostIds = Array.from(hostSet);
  if (!hostIds.length) return res.json([]);

  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, is_admin, is_banned, created_at, full_name, nickname, phone, host_chip_budget, host_chips_used')
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

// Admin: set or reset host chip budget
router.post('/admin/hosts/:id/budget', authMiddleware, adminMiddleware, async (req, res) => {
  const { budget, reset_used } = req.body;
  const update = {};
  if (budget !== undefined) update.host_chip_budget = Math.max(0, parseInt(budget) || 0);
  if (reset_used) update.host_chips_used = 0;
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
  const { error } = await supabaseAdmin.from('users').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Admin: get host chip-add transactions
router.get('/admin/hosts/:id/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, user_id, username, type, amount, table_name, notes, created_at')
    .eq('type', 'host_add_chips')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  // Filter to rows where this host was the actor
  const hostId = req.params.id;
  const filtered = (data || []).filter(row => {
    try { return JSON.parse(row.notes || '{}').actorId === hostId; } catch { return false; }
  });
  res.json(filtered);
});

router.get('/admin/players/contacts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, nickname, full_name, email, phone, role')
      .neq('is_banned', true)
      .order('username', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const { message, targetUserIds } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  const io = req.app.get('io');
  const { broadcastMessages, pendingMessages } = require('../socket/handlers');

  // targetUserIds: null or [] = broadcast to all; [uid, ...] = targeted
  const isTargeted = Array.isArray(targetUserIds) && targetUserIds.length > 0;

  const id = Date.now();
  const msg = {
    id,
    from: req.user.username,
    message: message.trim().slice(0, 500),
    targetUserIds: isTargeted ? targetUserIds : null,
    targetAll: !isTargeted,
    sentAt: Date.now()
  };

  // Persist in memory
  broadcastMessages.unshift(msg);
  if (broadcastMessages.length > 200) broadcastMessages.pop();

  console.log(`[broadcast/api] "${req.user.username}" → ${isTargeted ? `${targetUserIds.length} users` : 'ALL'} | "${msg.message}"`);

  let delivered = 0;
  let queued = 0;
  if (io) {
    if (isTargeted) {
      for (const uid of targetUserIds) {
        let sent = false;
        for (const [, s] of io.sockets.sockets) {
          if (s.user && s.user.id === uid) {
            s.emit('broadcast_message', msg);
            delivered++;
            sent = true;
          }
        }
        if (!sent) {
          if (!pendingMessages.has(uid)) pendingMessages.set(uid, []);
          pendingMessages.get(uid).push(msg);
          queued++;
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

  // Email + SMS all players (broadcast only — not for targeted messages)
  let emailsSent = 0;
  let smsSent = 0;
  let emailRecipients = [];
  let smsRecipients = [];

  try {
    const { sendPlayerEmail, sendPlayerSMS, sendAdminEmail, sendAdminPush } = require('../mail');

    // neq('is_banned', true) includes rows where is_banned IS NULL (most players)
    const { data: allUsers, error: usersErr } = await supabaseAdmin
      .from('users')
      .select('id, email, username, phone, nickname')
      .neq('is_banned', true);
    if (usersErr) console.warn('[broadcast] users query error:', usersErr.message);

    const onlineIds = new Set();
    if (io) { for (const [, s] of io.sockets.sockets) { if (s.user) onlineIds.add(s.user.id); } }

    const others = (allUsers || []).filter(u => u.id !== req.user.id);

    // Queue offline players for banner on next login (broadcast only)
    if (!isTargeted) {
      for (const u of others.filter(u => !onlineIds.has(u.id))) {
        if (!pendingMessages.has(u.id)) pendingMessages.set(u.id, []);
        pendingMessages.get(u.id).push(msg);
        queued++;
      }
    }

    // Only email + SMS for full broadcasts, not targeted messages
    if (!isTargeted) {
      emailRecipients = others.filter(u => u.email);
      smsRecipients   = others.filter(u => u.phone);

      console.log(`[broadcast] Sending to ${others.length} players — ${emailRecipients.length} with email, ${smsRecipients.length} with phone`);

      const emailSubject = `📨 Message from ${req.user.username} — RabbsRoom`;
      const emailBodyText = (name) =>
        `Hi ${name},\n\n${req.user.username} sent a message:\n\n"${msg.message}"\n\nLog in at https://rabbsroom.com\n\n— Boston Poker Club`;
      const emailBodyHtml = (name) => `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#1a7a3f">📨 Message from ${req.user.username}</h2>
          <p>Hi <strong>${name}</strong>,</p>
          <p style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:1rem;line-height:1.6">${msg.message.replace(/\n/g, '<br>')}</p>
          <p style="color:#666;font-size:.85rem">Log in to <a href="https://rabbsroom.com" style="color:#1a7a3f">RabbsRoom</a> to see your message inbox.</p>
          <p style="color:#999;font-size:.8rem">— Boston Poker Club · noreply@rabbsroom.com</p>
        </div>`;

      for (const u of emailRecipients) {
        const name = u.nickname || u.username || 'there';
        try {
          await sendPlayerEmail({ to: u.email, subject: emailSubject, text: emailBodyText(name), html: emailBodyHtml(name) });
          emailsSent++;
          console.log('[broadcast] Email sent to:', u.email);
        } catch (e) {
          console.warn('[broadcast] Email failed for', u.email, ':', e.message);
        }
      }

      const smsText = `RabbsRoom msg from ${req.user.username}: ${msg.message}`.slice(0, 160);
      for (const u of smsRecipients) {
        try {
          await sendPlayerSMS({ phone: u.phone, text: smsText });
          smsSent++;
          console.log('[broadcast] SMS sent to:', u.phone);
        } catch (e) {
          console.warn('[broadcast] SMS failed for', u.phone, ':', e.message);
        }
      }

      console.log(`[broadcast] Done — ${emailsSent}/${emailRecipients.length} emails, ${smsSent}/${smsRecipients.length} SMS`);

      // Admin confirmation copy
      try {
        const adminSubject = `📢 Broadcast sent — "${msg.message.slice(0, 60)}${msg.message.length > 60 ? '…' : ''}"`;
        const adminText = `Broadcast by ${req.user.username}:\n\n"${msg.message}"\n\nDelivered: ${emailsSent} emails, ${smsSent} SMS.\nEmails: ${emailRecipients.map(u => u.email).join(', ') || 'none'}\nPhones: ${smsRecipients.map(u => u.phone).join(', ') || 'none'}`;
        await sendAdminEmail({ subject: adminSubject, text: adminText, html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${adminText}</pre>` });
        console.log('[broadcast] Admin email copy sent to bostonspokerclub.amitureflops@gmail.com');
        await sendAdminPush(`Broadcast: "${msg.message.slice(0, 80)}" — ${emailsSent}em/${smsSent}sms`, 'RabbsRoom Broadcast');
        console.log('[broadcast] Admin push sent via ntfy');
      } catch (e) {
        console.warn('[broadcast] Admin copy error:', e.message);
      }
    }

    // Attach delivery audit to message object for history view
    msg.delivery = {
      emailCount: emailsSent,
      smsCount: smsSent,
      emails: emailRecipients.map(u => ({ username: u.username, nickname: u.nickname || '', email: u.email })),
      phones: smsRecipients.map(u => ({ username: u.username, nickname: u.nickname || '', phone: u.phone }))
    };
  } catch (e) {
    console.warn('[broadcast] delivery error:', e.message);
  }

  res.json({ ok: true, delivered, queued, emailsSent, smsSent, message: msg });
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
  const { amount, paymentMethod, notes, tableId: reqTableId, isRebuy } = req.body;
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
    paymentMethod: String(paymentMethod || 'Cash').slice(0, 80),
    notes: String(notes || '').slice(0, 200),
    requestedAt: Date.now(),
    status: 'pending',
    tableId: reqTableId ? String(reqTableId).slice(0, 100) : null,
    isRebuy: !!isRebuy
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

  // Send email + push to admin
  try {
    const { sendAdminEmail, sendAdminPush } = require('../mail');
    const displayName = nickname ? `${req.user.username} (${nickname})` : req.user.username;
    const label = request.isRebuy ? '🔄 Rebuy' : '💰 Buy-In';
    const subject = `${label} Request — ${displayName} $${amount} chips`;
    const rebuyRow = request.isRebuy
      ? `<tr style="background:#fffbe6"><td style="padding:8px 14px;color:#555">Type</td><td style="padding:8px 14px;font-weight:700;color:#b8860b">🔄 REBUY — chips go to table stack</td></tr>`
      : '';
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a7a3f">${label} Request — RabbsRoom</h2>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px">
          ${rebuyRow}
          <tr><td style="padding:8px 14px;color:#555;width:140px">Username</td><td style="padding:8px 14px;font-weight:700">${req.user.username}</td></tr>
          ${nickname ? `<tr style="background:#fff"><td style="padding:8px 14px;color:#555">Nickname</td><td style="padding:8px 14px">${nickname}</td></tr>` : ''}
          ${phone ? `<tr><td style="padding:8px 14px;color:#555">Phone</td><td style="padding:8px 14px">${phone}</td></tr>` : ''}
          <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Amount</td><td style="padding:8px 14px;font-weight:700;font-size:1.1rem;color:#1a7a3f">${amount} chips</td></tr>
          <tr><td style="padding:8px 14px;color:#555">Payment Method</td><td style="padding:8px 14px;font-weight:700">${request.paymentMethod}</td></tr>
          ${notes ? `<tr style="background:#fff"><td style="padding:8px 14px;color:#555">Notes</td><td style="padding:8px 14px">${notes}</td></tr>` : ''}
        </table>
        <p style="margin-top:20px;color:#666">Log in to <a href="https://rabbsroom.com/admin.html" style="color:#1a7a3f">admin panel</a> → Pending Buy-Ins to approve.</p>
      </div>`;
    const text = `${request.isRebuy ? 'REBUY' : 'Buy-In'}: ${displayName}${phone ? ' ' + phone : ''} wants $${amount} chips via ${request.paymentMethod}${notes ? '. ' + notes : ''}. Approve: rabbsroom.com/admin.html`;
    await sendAdminEmail({ subject, text, html });
    await sendAdminPush(text, `${request.isRebuy ? 'Rebuy' : 'Buy-In'}: ${displayName}`);
    console.log(`[buyin] Notification sent for ${displayName} $${amount} (${request.isRebuy ? 'rebuy' : 'buyin'})`);
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

  const { data: user, error: fetchErr } = await supabaseAdmin.from('users').select('chips, email, phone').eq('id', request.userId).single();
  if (fetchErr || !user) return res.status(404).json({ error: 'Player not found' });

  request.status = 'approved';
  request.approvedAt = Date.now();
  request.approvedBy = req.user.username;

  const io = req.app.get('io');
  let newChips;

  if (request.isRebuy && request.tableId) {
    // Rebuy: add chips directly to the player's live table stack via appEvents.
    // The handler in socket/handlers.js updates the in-memory game object,
    // persists to table_seats, and broadcasts game_state to all table clients.
    appEvents.emit('rebuy:approved', {
      userId: request.userId,
      tableId: request.tableId,
      amount: request.amount,
      adminName: req.user.username
    });
    newChips = user.chips; // bank balance unchanged for rebuys
  } else {
    // Regular buy-in: add to the player's chip bank balance
    newChips = (user.chips || 0) + request.amount;
    const { error: updateErr } = await supabaseAdmin.from('users').update({ chips: newChips }).eq('id', request.userId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    // Notify all connected sockets for this player
    if (io) {
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === request.userId) {
          s.emit('chips_received', { amount: request.amount, from: 'Admin', newTotal: newChips });
        }
      }
    }
  }

  logTransaction({
    userId: request.userId,
    username: request.username,
    type: request.isRebuy ? 'rebuy' : 'buyin',
    amount: request.amount,
    paymentMethod: request.paymentMethod,
    notes: request.notes || null
  });

  // Notify player via email + SMS
  try {
    const { sendPlayerEmail, sendPlayerSMS } = require('../mail');
    const label = request.isRebuy ? 'Rebuy' : 'Buy-In';
    const subject = `✅ ${label} Approved — $${request.amount.toLocaleString()} chips added`;
    const bodyDetail = request.isRebuy
      ? `Your rebuy of $${request.amount.toLocaleString()} chips has been approved and added to your table stack.`
      : `Your buy-in of $${request.amount.toLocaleString()} chips has been approved and added to your account.\n\nNew balance: $${newChips.toLocaleString()} chips.`;
    const text = `Hi ${request.username},\n\n${bodyDetail}\n\nGood luck at the tables!\n— RabbsRoom`;
    const html = `<p>Hi <strong>${request.username}</strong>,</p><p>${bodyDetail.replace(/\n/g, '<br>')}</p><p>Good luck at the tables!<br>— RabbsRoom</p>`;
    if (user.email) await sendPlayerEmail({ to: user.email, subject, text, html });
    if (user.phone) await sendPlayerSMS({ phone: user.phone, text: `Boston Poker Club: $${request.amount.toLocaleString()} chips ${request.isRebuy ? 'added to your table stack' : 'added to your account'}. Good luck!` });
  } catch (e) {
    console.warn('[buyin] Player notification error:', e.message);
  }

  console.log(`[buyin] Approved: ${request.username} +$${request.amount} chips (${request.isRebuy ? 'rebuy→table' : 'buyin→bank'})`);
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
    is_host: true
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
  try {
    await supabaseAdmin.from('monthly_fees').insert({
      user_id: newUser.id,
      username: newUser.username,
      role_type: 'host',
      fee_amount: 20,
      next_due_date: nextDue.toISOString().slice(0, 10),
      is_overdue: false
    });
  } catch (e) { console.warn('[fees] insert host fee record error:', e.message); }

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
    is_admin: true
  }).select('id, username, email').single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
    return res.status(500).json({ error: error.message });
  }

  // Store application record for audit trail
  try {
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
    });
  } catch (e) { console.warn('[admin-create] host_applications insert error:', e.message); }

  const nextDue = new Date();
  nextDue.setDate(1);
  nextDue.setMonth(nextDue.getMonth() + 1);
  try {
    await supabaseAdmin.from('monthly_fees').insert({
      user_id: newUser.id,
      username: newUser.username,
      role_type: 'admin',
      fee_amount: 40,
      next_due_date: nextDue.toISOString().slice(0, 10),
      is_overdue: false
    });
  } catch (e) { console.warn('[fees] insert admin fee record error:', e.message); }

  res.json({ ok: true, userId: newUser.id, username: newUser.username });
});

// ─── Monthly Fees ─────────────────────────────────────────────────────────────

router.get('/admin/monthly-fees', authMiddleware, adminMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await supabaseAdmin.from('monthly_fees')
      .update({ is_overdue: true, updated_at: new Date().toISOString() })
      .lt('next_due_date', today);
  } catch (e) { console.warn('[fees] overdue update error:', e.message); }

  const { data, error } = await supabaseAdmin.from('monthly_fees')
    .select('*')
    .order('role_type', { ascending: false })
    .order('username');
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with nickname from users table
  if (data?.length) {
    const userIds = [...new Set(data.map(r => r.user_id))];
    let _usersRes; try { _usersRes = await supabaseAdmin.from('users').select('id, nickname, phone').in('id', userIds); } catch { _usersRes = { data: [] }; }
    const { data: users } = _usersRes;
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
  try { await supabaseAdmin.from('users').update({ fee_suspended: false }).eq('id', userId); } catch (e) { console.warn('[fees] unsuspend error:', e.message); }

  // Remove from in-memory suspended set
  try { const { feeSuspendedUsers } = require('../fees'); feeSuspendedUsers.delete(userId); } catch {}

  // Record payment in history table
  if (fee) {
    const forMonth = new Date(); forMonth.setDate(1);
    try {
      await supabaseAdmin.from('monthly_fee_payments').insert({
        user_id: userId,
        username: fee.username,
        role_type: fee.role_type,
        amount: fee.fee_amount,
        for_month: forMonth.toISOString().slice(0, 10),
        payment_method: payment_method || null,
        notes: notes || null
      });
    } catch (e) { console.warn('[fees] payment history insert error:', e.message); }
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
      .select('user_id', { count: 'exact' }).eq('is_overdue', true);

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
// Financial amounts (total_won, biggest_pot) are only included for admins
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const isAdmin = !!req.user.isAdmin;
    const defaultSort = isAdmin ? 'total_won' : 'sessions_played';
    const by = req.query.by || defaultSort;
    const validColumns = ['total_won', 'biggest_pot', 'sessions_played', 'hands_won'];
    const orderCol = validColumns.includes(by) ? by : defaultSort;

    const { data, error } = await supabaseAdmin
      .from('player_stats')
      .select('user_id, username, hands_played, hands_won, total_won, biggest_pot, sessions_played, favorite_hand')
      .order(orderCol, { ascending: false })
      .limit(10);

    if (error) throw error;

    // Fetch nicknames and avatar URLs from users table
    const userIds = (data || []).map(r => r.user_id);
    let userMap = {};
    if (userIds.length) {
      const { data: udata } = await supabaseAdmin
        .from('users').select('id, nickname, avatar_url').in('id', userIds);
      if (udata) udata.forEach(u => { userMap[u.id] = u; });
    }

    const rows = (data || []).map((r, i) => {
      const row = {
        rank: i + 1,
        user_id: r.user_id,
        username: r.username,
        nickname: userMap[r.user_id]?.nickname || '',
        avatar_url: userMap[r.user_id]?.avatar_url || null,
        hands_played: r.hands_played,
        hands_won: r.hands_won,
        sessions_played: r.sessions_played,
        favorite_hand: r.favorite_hand,
        win_rate: r.hands_played > 0 ? Math.round((r.hands_won / r.hands_played) * 100) : 0,
      };
      if (isAdmin) {
        row.total_won = r.total_won;
        row.biggest_pot = r.biggest_pot;
      }
      return row;
    });

    res.json({ leaderboard: rows, isAdmin });
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

// GET /api/members  — public member list (nickname, avatar, join date, sessions, online)
// No personal info (no email, phone, real name, chip counts) exposed.
router.get('/members', authMiddleware, async (req, res) => {
  try {
    // Fetch all non-banned users with public fields
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, username, nickname, avatar_url, created_at')
      .eq('is_banned', false)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Fetch session counts for all users
    const { data: statsRows } = await supabaseAdmin
      .from('player_stats')
      .select('user_id, sessions_played');

    const statsMap = new Map((statsRows || []).map(s => [s.user_id, s.sessions_played]));

    // Check who is currently connected via socket
    let onlineSet = new Set();
    try {
      const { userSockets } = require('../socket/handlers');
      onlineSet = new Set(userSockets.keys());
    } catch {}

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const members = (users || []).map(u => {
      const d = new Date(u.created_at);
      return {
        displayName: u.nickname || u.username,
        avatarUrl: u.avatar_url || null,
        memberSince: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        sessionsPlayed: statsMap.get(u.id) || 0,
        isOnline: onlineSet.has(u.id)
      };
    });

    res.json({ members, total: members.length });
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

// ─── Login Audit ──────────────────────────────────────────────────────────────

router.get('/admin/login-audit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const failOnly = req.query.fail === '1';

    const q = supabaseAdmin.from('login_audit')
      .select('id, user_id, username, ip_address, user_agent, success, failure_reason, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (failOnly) q.eq('success', false);

    const { data, error } = await q;
    if (error) {
      if (/does not exist|relation/.test(error.message)) return res.json({ entries: [], suspicious: [] });
      return res.status(500).json({ error: error.message });
    }

    // Detect suspicious: same user_id from 2+ distinct IPs in last 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = (data || []).filter(e => e.success && e.created_at >= cutoff);
    const ipsByUser = {};
    recent.forEach(e => {
      if (!e.user_id) return;
      if (!ipsByUser[e.user_id]) ipsByUser[e.user_id] = new Set();
      ipsByUser[e.user_id].add(e.ip_address);
    });
    const suspicious = Object.entries(ipsByUser)
      .filter(([, ips]) => ips.size >= 2)
      .map(([userId, ips]) => {
        const entry = recent.find(e => e.user_id === userId);
        return { userId, username: entry?.username, ipCount: ips.size, ips: [...ips] };
      });

    res.json({ entries: data || [], suspicious });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Player Notes ─────────────────────────────────────────────────────────────

router.get('/admin/players/:id/notes', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('player_notes')
    .select('id, note, author_username, created_at')
    .eq('player_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) {
    if (/does not exist|relation/.test(error.message)) return res.json([]);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

router.post('/admin/players/:id/notes', authMiddleware, adminMiddleware, async (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Note text is required' });
  const { data, error } = await supabaseAdmin.from('player_notes').insert({
    player_id: req.params.id,
    author_id: req.user.id,
    author_username: req.user.username,
    note: note.trim().slice(0, 500)
  }).select('id, note, author_username, created_at').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/admin/players/:id/notes/:noteId', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin.from('player_notes')
    .delete().eq('id', req.params.noteId).eq('player_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});


router.get('/admin/players/:id/login-history', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('login_audit')
      .select('ip_address, user_agent, success, failure_reason, created_at')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      if (/does not exist|relation/.test(error.message)) return res.json([]);
      return res.status(500).json({ error: error.message });
    }
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/export/login-audit.csv', authMiddleware, adminMiddleware, async (req, res) => {
  const { from, to } = _csvRange(req);
  const { data, error } = await supabaseAdmin.from('login_audit')
    .select('created_at, username, ip_address, success, failure_reason, user_agent')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) {
    if (/does not exist|relation/.test(error.message)) return _sendCsv(res, 'login_audit_empty.csv', [_csvRow(['Run migration 009 first'])]);
    return res.status(500).json({ error: error.message });
  }
  const rows = [
    _csvRow(['Date','Username','IP Address','Success','Failure Reason','User Agent']),
    ...(data || []).map(r => _csvRow([r.created_at?.slice(0,19), r.username, r.ip_address, r.success ? 'Yes' : 'No', r.failure_reason || '', r.user_agent || '']))
  ];
  _sendCsv(res, `login_audit_${from}_${to}.csv`, rows);
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
    let _feeRowsRes; try { _feeRowsRes = await supabaseAdmin.from('monthly_fee_payments').select('amount, created_at'); } catch { _feeRowsRes = { data: [] }; }
    const { data: feeRows } = _feeRowsRes;
    const allFees    = feeRows || [];
    const feeAll     = sum(allFees, 'amount');
    const feeMonth   = allFees.filter(f => f.created_at >= monthStart.toISOString()).reduce((s, f) => s + (f.amount || 0), 0);

    // Top players by buy-in volume
    let _txDataRes; try { _txDataRes = await supabaseAdmin.from('transactions').select('username, amount').eq('type', 'buy_in'); } catch { _txDataRes = { data: [] }; }
    const { data: txData } = _txDataRes;
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
    .select('id, username, full_name, nickname, phone, email, address, city, state, zip, is_admin, is_host, created_at')
    .gte('created_at', from + 'T00:00:00Z')
    .lte('created_at', to   + 'T23:59:59Z')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  let _txDataRes2; try { _txDataRes2 = await supabaseAdmin.from('transactions').select('user_id, type, amount'); } catch { _txDataRes2 = { data: [] }; }
  const { data: txData } = _txDataRes2;
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

    let _feeDataRes; try { _feeDataRes = await supabaseAdmin.from('monthly_fee_payments').select('amount, username').gte('created_at', weekAgo.toISOString()); } catch { _feeDataRes = { data: [] }; }
    const { data: feeData } = _feeDataRes;
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

// ─── Player Profile (self) ────────────────────────────────────────────────────

router.get('/me/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  let { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, chips, full_name, nickname, phone, created_at, is_admin, avatar_url')
    .eq('id', userId)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const isHost = hostSet.has(userId);

  // Stats: wins from transactions table
  const { data: txns } = await supabaseAdmin
    .from('transactions')
    .select('amount, type, table_name, created_at, notes')
    .eq('user_id', userId)
    .eq('type', 'win')
    .order('created_at', { ascending: false })
    .limit(100);

  const wins = txns || [];
  const handsWon = wins.length;
  const biggestPot = wins.reduce((max, t) => Math.max(max, t.amount || 0), 0);
  const totalWon = wins.reduce((sum, t) => sum + (t.amount || 0), 0);
  const recentSessions = wins.slice(0, 10).map(t => ({
    amount: t.amount, tableName: t.table_name, handName: t.notes, date: t.created_at
  }));

  // Live table stats if at a table
  let liveStats = null;
  try {
    const { getTableStats: _gts, activeGames: _ag } = require('../socket/handlers');
    for (const [tid, game] of _ag) {
      if (game.getPlayer(userId)) {
        liveStats = _gts(tid);
        break;
      }
    }
  } catch {}

  res.json({
    ...data,
    is_host: isHost,
    stats: { handsWon, biggestPot, totalWon },
    recentSessions,
    liveStats
  });
});

router.put('/me/profile', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { nickname, phone, email } = req.body;

  const updates = {};
  if (nickname !== undefined) updates.nickname = String(nickname || '').trim().slice(0, 50);
  if (phone !== undefined) updates.phone = String(phone || '').trim().slice(0, 20);
  if (email !== undefined && email) {
    const normalizedEmail = email.replace(/\s/g, '');
    if (!/@/.test(normalizedEmail) || !/\.[a-zA-Z]{2,}$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email address — must contain @ and a valid domain (e.g. name@gmail.com)' });
    }
    updates.email = normalizedEmail.slice(0, 200);
  }

  if (!Object.keys(updates).length) return res.json({ ok: true });

  const { error } = await supabaseAdmin.from('users').update(updates).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

// ─── Avatar Upload ────────────────────────────────────────────────────────────

router.post('/me/avatar', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { imageData } = req.body;
  if (!imageData || typeof imageData !== 'string') return res.status(400).json({ error: 'No image provided' });

  try {
    const match = imageData.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image format' });
    const [, contentType, b64] = match;
    const buffer = Buffer.from(b64, 'base64');
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${userId}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('avatars')
      .upload(path, buffer, { contentType, upsert: true });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data: { publicUrl } } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);

    await supabaseAdmin.from('users').update({ avatar_url: publicUrl }).eq('id', userId);

    res.json({ ok: true, avatar_url: publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Change Password ──────────────────────────────────────────────────────────

router.post('/me/password/set-new', authMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: user } = await supabaseAdmin.from('users')
    .select('must_change_password').eq('id', req.user.id).single();
  if (!user?.must_change_password) return res.status(403).json({ error: 'No password change required' });

  const hash = await bcrypt.hash(newPassword, 10);
  try {
    await supabaseAdmin.from('users')
      .update({ password_hash: hash, must_change_password: false })
      .eq('id', req.user.id);
  } catch {
    await supabaseAdmin.from('users').update({ password_hash: hash }).eq('id', req.user.id);
  }
  res.json({ ok: true });
});

router.put('/me/password', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });

    const current = String(currentPassword).trim();
    const newPw   = String(newPassword).trim();
    if (newPw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const { data: user, error: fetchErr } = await supabaseAdmin
      .from('users').select('password_hash').eq('id', userId).single();
    if (fetchErr || !user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPw, 10);
    const { error: updateErr } = await supabaseAdmin
      .from('users').update({ password_hash: newHash }).eq('id', userId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({ ok: true });
  } catch (e) {
    console.error('[change-password] Unexpected error:', e.message);
    res.status(500).json({ error: 'Something went wrong updating your password, please try again' });
  }
});

// ─── Table Stats (public) ─────────────────────────────────────────────────────

router.get('/tables/:id/stats', authMiddleware, async (req, res) => {
  try {
    const { getTableStats: _gts } = require('../socket/handlers');
    res.json(_gts(req.params.id));
  } catch {
    res.json({ handsPlayed: 0, handsPerHour: 0, avgPot: 0, biggestPot: 0 });
  }
});

// ─── Highlights ────────────────────────────────────────────────────────────────

router.get('/highlights', async (req, res) => {
  const category = req.query.category;
  let q = supabaseAdmin.from('highlights').select('*').order('created_at', { ascending: false }).limit(50);
  if (category && category !== 'all') q = q.eq('category', category);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/highlights/upload-url', authMiddleware, adminMiddleware, async (req, res) => {
  const { filename } = req.body;
  const ext = (filename || 'clip.webm').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'webm';
  const path = `clips/${req.user.id}/${Date.now()}.${ext}`;
  const { data, error } = await supabaseAdmin.storage.from('highlights').createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ signedUrl: data.signedUrl, path, token: data.token });
});

router.post('/highlights', authMiddleware, adminMiddleware, async (req, res) => {
  const { title, description, category, storage_path, thumbnail_url } = req.body;
  if (!title || !storage_path) return res.status(400).json({ error: 'title and storage_path required' });
  const { data: { publicUrl } } = supabaseAdmin.storage.from('highlights').getPublicUrl(storage_path);
  const { data, error } = await supabaseAdmin.from('highlights').insert({
    title: String(title).slice(0, 120),
    description: String(description || '').slice(0, 500),
    category: ['bad_beat', 'big_win', 'bluff', 'funny', 'general'].includes(category) ? category : 'general',
    video_url: publicUrl,
    storage_path,
    thumbnail_url: thumbnail_url || null,
    uploaded_by: req.user.id,
    uploader_username: req.user.username
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/highlights/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { data: hl } = await supabaseAdmin.from('highlights').select('storage_path').eq('id', req.params.id).single();
  if (hl?.storage_path) await supabaseAdmin.storage.from('highlights').remove([hl.storage_path]);
  const { error } = await supabaseAdmin.from('highlights').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/highlights/:id/like', authMiddleware, async (req, res) => {
  const highlightId = req.params.id;
  const userId = req.user.id;
  const { data: existing } = await supabaseAdmin.from('highlight_likes')
    .select('highlight_id').eq('highlight_id', highlightId).eq('user_id', userId).maybeSingle();
  if (existing) {
    await supabaseAdmin.from('highlight_likes').delete().eq('highlight_id', highlightId).eq('user_id', userId);
    const { data: hl } = await supabaseAdmin.from('highlights').select('likes_count').eq('id', highlightId).single();
    await supabaseAdmin.from('highlights').update({ likes_count: Math.max(0, (hl?.likes_count || 1) - 1) }).eq('id', highlightId);
    return res.json({ liked: false });
  }
  await supabaseAdmin.from('highlight_likes').insert({ highlight_id: highlightId, user_id: userId });
  const { data: hl } = await supabaseAdmin.from('highlights').select('likes_count').eq('id', highlightId).single();
  await supabaseAdmin.from('highlights').update({ likes_count: (hl?.likes_count || 0) + 1 }).eq('id', highlightId);
  res.json({ liked: true });
});

router.get('/highlights/:id/comments', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('highlight_comments').select('*').eq('highlight_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/highlights/:id/comments', authMiddleware, async (req, res) => {
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment required' });
  const { data, error } = await supabaseAdmin.from('highlight_comments').insert({
    highlight_id: req.params.id, user_id: req.user.id,
    username: req.user.username, comment: String(comment).slice(0, 500)
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/highlights/:id/comments/:cid', authMiddleware, adminMiddleware, async (req, res) => {
  await supabaseAdmin.from('highlight_comments').delete().eq('id', req.params.cid);
  res.json({ ok: true });
});

// ─── Google TTS proxy ─────────────────────────────────────────────────────────
// Proxies text→speech requests to Google TTS, keeping the API key server-side.
// Returns audio/mpeg (mp3). Client plays it via Audio element.
// Requires GOOGLE_TTS_API_KEY env var. Returns 503 if not configured.
router.post('/tts', authMiddleware, async (req, res) => {
  const key = process.env.GOOGLE_TTS_API_KEY;
  if (!key) return res.status(503).json({ error: 'TTS not configured' });
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.length > 500) {
    return res.status(400).json({ error: 'Invalid text' });
  }
  try {
    const ttsRes = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 0.85, pitch: -3.0 }
        })
      }
    );
    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[TTS] Google API error:', err);
      return res.status(502).json({ error: 'TTS API error' });
    }
    const data = await ttsRes.json();
    const audio = Buffer.from(data.audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(audio);
  } catch (e) {
    console.error('[TTS] fetch error:', e.message);
    res.status(500).json({ error: 'TTS request failed' });
  }
});

module.exports = router;
