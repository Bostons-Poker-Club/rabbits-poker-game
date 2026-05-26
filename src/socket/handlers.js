'use strict';

const jwt = require('jsonwebtoken');
const { PokerGame } = require('../game/poker-game');
const { Tournament } = require('../game/tournament');
const { sendTableRequestEmail, sendBroadcastEmail, sendPlayerSMS, sendPlayerEmail, sendAdminPush } = require('../mail');
const { supabaseAdmin } = require('../db/supabase');
const { logTransaction } = require('../transactions');

const appEvents = require('../events');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JACKPOT_INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;
const JACKPOT_CONTRIB = parseFloat(process.env.JACKPOT_CONTRIBUTION_PERCENT) || 1;
const SHOT_CLOCK = parseInt(process.env.SHOT_CLOCK_SECONDS) || 40;

// Tiered rake by stakes — all 10%, caps vary by game size
// $1/$3          sb≤1, bb≤3  → 10% capped at $7
// $2/$2 PLO      sb=2, bb=2  → 10% capped at $12
// $2/$5          sb=2, bb=5  → 10% capped at $12
// $5/$5 / $5/$10 sb=5        → 10% capped at $15
// $10/$20+                   → 10% capped at $20
function getRakeConfig(smallBlind, bigBlind) {
  if (bigBlind <= 3 && smallBlind <= 1) return { rakePercent: 10, rakeCap: 7 };
  if (bigBlind <= 5 && smallBlind <= 2) return { rakePercent: 10, rakeCap: 12 };
  if (bigBlind <= 10)                   return { rakePercent: 10, rakeCap: 15 };
  return                                       { rakePercent: 10, rakeCap: 20 };
}

// Minimum buy-in per table stakes — must mirror the client-side version in lobby.js
function getMinBuyIn(sb, bb, gameType) {
  sb = Number(sb); bb = Number(bb);
  if (gameType === 'plo') {
    if (sb === 2 && bb === 2) return 100;
    return bb * 50;
  }
  if (sb === 1 && bb === 3)  return 60;
  if (sb === 2 && bb === 5)  return 200;
  if (sb === 5 && bb === 5)  return 500;
  if (sb === 5 && bb === 10) return 500;
  return bb * 20;
}

// In-memory state
const activeGames = new Map();       // tableId -> PokerGame
const activeTournaments = new Map(); // tournamentId -> Tournament
const socketUsers = new Map();       // socketId -> { userId, username, isAdmin }
const userSockets = new Map();       // userId -> socketId
const playerProfiles = new Map();    // userId -> { avatarUrl, isAdmin, isHost }
const tableSpectators = new Map();   // tableId -> Set<socketId> (admin observers)

// Per-table jackpot state
// tableJackpots: Map<tableId, { tableName, amount, highHandRank, highHandUserId, highHandUsername, highHandDescription, timerStart }>
const tableJackpots = new Map();
let jackpotIo = null;

// Keep legacy single `jackpot` for DB compat (used only for loadJackpotFromDB/saveJackpotToDB)
let jackpot = { amount: 0, highHandRank: -1, highHandUserId: null, timerStart: Date.now() };

// Session rake tracking (resets on server restart)
// byTable: Map<tableId, { tableName, total, hands[] }>
const sessionRake = { total: 0, byTable: new Map() };

// Money puck state: tableId -> { holderId, holderSeat, holderName, value, autoDropMs, autoDropTimer, straddleTimeout }
const tablePucks = new Map();

// Admin notification feed (in-memory, resets on restart)
const adminNotifs = [];
let adminNotifSeq = 0;

// Rail waiting queue: { id, userId, username, nickname, phone, chips, requestedAt }
const railQueue = [];

// Per-table waiting lists: tableId -> [{ userId, username, phone, socketId, joinedAt }]
const tableWaitlists = new Map();

// Per-table session stats: tableId -> { handsPlayed, sessionStart, totalPot, biggestPot, recentTimestamps }
const tableStats = new Map();

// Per-table rabbit hunt data (cleared after use): tableId -> { cards, foldedCards, communityCards }
const tableRabbitData = new Map();

// Host table requests: { id, hostId, hostName, gameType, sb, bb, maxPlayers, rake, requestedAt, status }
const tableRequests = [];
let tableRequestSeq = 0;

// Ban enforcement — populated from DB on startup, updated on ban/unban
const bannedUsers = new Set();

// Jackpot payouts pending admin confirmation after timer expiry
const pendingJackpotPayouts = new Map(); // tableId -> { amount, userId, username, hand, expiredAt }

// Broadcast messages history + offline queue
const broadcastMessages = [];
let broadcastMsgSeq = 0;
const pendingMessages = new Map(); // userId -> msg[]

// Player replies to admin messages
const playerReplies = [];

// PTT admin controls per table
const tableMicMuted  = new Map();  // tableId -> Set<userId>
const tablePttMode   = new Map();  // tableId -> 'ptt' | 'openmic'
const tableMicStatus = new Map();  // tableId -> Map<userId, string>

async function loadBannedUsersFromDB() {
  try {
    const { data } = await supabaseAdmin.from('users').select('id').eq('is_banned', true);
    if (data) data.forEach(u => bannedUsers.add(u.id));
  } catch {}
}

function getAdminSockets(io) {
  const sids = [];
  for (const [sid, info] of socketUsers) {
    if (info.isAdmin) sids.push(sid);
  }
  return sids;
}

function pushAdminNotif(io, { type, title, body, data = {} }) {
  const notif = { id: ++adminNotifSeq, type, title, body, data, ts: Date.now(), read: false };
  adminNotifs.unshift(notif);
  if (adminNotifs.length > 300) adminNotifs.pop();
  for (const sid of getAdminSockets(io)) {
    io.to(sid).emit('admin:notification', notif);
  }
}

function broadcastPuckState(io, tableId) {
  const puck = tablePucks.get(tableId);
  io.to(tableId).emit('puck:state', puck
    ? { tableId, holderId: puck.holderId, holderSeat: puck.holderSeat, holderName: puck.holderName, value: puck.value }
    : { tableId, holderId: null }
  );
}

function passMoneyPuck(io, tableId, game) {
  const puck = tablePucks.get(tableId);
  if (!puck) return;

  // Clear any pending timers
  if (puck.straddleTimeout) { clearTimeout(puck.straddleTimeout); puck.straddleTimeout = null; }
  if (puck.autoDropTimer)   { clearInterval(puck.autoDropTimer);  puck.autoDropTimer = null; }

  // Find next player to the left (next seat number, wrapping around)
  const sortedSeats = Array.from(game.seats.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([seat, uid]) => ({ seat, uid }));

  if (!sortedSeats.length) { tablePucks.delete(tableId); broadcastPuckState(io, tableId); return; }

  const idx = sortedSeats.findIndex(s => s.seat === puck.holderSeat);
  const nextIdx = idx === -1 || idx === sortedSeats.length - 1 ? 0 : idx + 1;
  const next = sortedSeats[nextIdx];
  const nextPlayer = game.players.get(next.uid);
  if (!nextPlayer) { tablePucks.delete(tableId); broadcastPuckState(io, tableId); return; }

  puck.holderId   = nextPlayer.userId;
  puck.holderSeat = nextPlayer.seatNumber;
  puck.holderName = nextPlayer.username;
  broadcastPuckState(io, tableId);
  io.to(tableId).emit('chat', { username: 'system', message: `💰 Money Puck passed to ${nextPlayer.username}` });

  // Restart auto-drop timer if configured
  if (puck.autoDropMs > 0) {
    puck.autoDropTimer = setInterval(() => passMoneyPuck(io, tableId, game), puck.autoDropMs);
  }
}

// ─── Game Watchdog ────────────────────────────────────────────────────────────
// Fires every 15s per game; detects and recovers stuck or idle game states.

function setupGameWatchdog(io, tableId, game) {
  if (game._watchdog) { clearInterval(game._watchdog); game._watchdog = null; }

  game._watchdog = setInterval(() => {
    if (!activeGames.has(tableId)) {
      clearInterval(game._watchdog);
      game._watchdog = null;
      return;
    }

    // No active hand but players are seated — start one (skip if paused)
    if (!game.handActive) {
      if (!game.isPaused && game.canStartHand()) {
        const idleMs = Date.now() - (game.lastActionAt || 0);
        if (idleMs > 8000) {
          console.log(`[watchdog] ${tableId}: idle ${Math.round(idleMs/1000)}s, no hand — starting`);
          startNewHand(io, tableId, game);
        }
      }
      return;
    }

    // Detect stuck hand: no lastActionAt update for longer than shot-clock + buffer
    const staleThreshold = ((game.shotClockDuration || 40) + 20) * 1000;
    const stuckMs = Date.now() - (game.lastActionAt || Date.now());
    if (stuckMs < staleThreshold) return;

    console.warn(`[watchdog] STUCK ${tableId} ${Math.round(stuckMs/1000)}s | hand#${game.handNumber} street:${game.currentStreet} seat:${game.currentPlayerSeat}`);
    io.to(tableId).emit('chat', { username: 'system', message: `⚠️ Recovering stuck hand (${Math.round(stuckMs/1000)}s idle)` });

    // Step 1: fold the current player
    const curr = game.getPlayerBySeat(game.currentPlayerSeat);
    if (curr && !curr.hasFolded && !curr.isAllIn) {
      try {
        console.warn(`[watchdog] auto-folding ${curr.username}`);
        const result = game.processAction(curr.userId, 'fold');
        game.lastActionAt = Date.now();
        broadcastGameState(io, tableId, game);
        handleActionResult(io, tableId, game, result);
        return;
      } catch (e) { console.error('[watchdog] fold failed:', e.message); }
    }

    // Step 2: mark all players as acted and advance street
    try {
      console.warn('[watchdog] forcing street advance');
      game.playersActedThisStreet = new Set(game.getHandPlayers().map(p => p.userId));
      for (const p of game.getHandPlayers()) p.currentBet = game.currentBet;
      const result = game.advanceStreet();
      game.lastActionAt = Date.now();
      broadcastGameState(io, tableId, game);
      handleActionResult(io, tableId, game, result);
      return;
    } catch (e) { console.error('[watchdog] advance failed:', e.message); }

    // Step 3: force showdown
    try {
      console.warn('[watchdog] forcing showdown');
      game.handActive = true;
      const result = game.showdown();
      game.lastActionAt = Date.now();
      broadcastGameState(io, tableId, game);
      handleActionResult(io, tableId, game, result);
      return;
    } catch (e) { console.error('[watchdog] showdown failed:', e.message); }

    // Step 4: hard reset
    console.error(`[watchdog] hard reset at ${tableId}`);
    game.handActive = false;
    game.clearShotClock();
    game.lastActionAt = Date.now();
    broadcastGameState(io, tableId, game);
    io.to(tableId).emit('chat', { username: 'system', message: '⚠️ Hand reset due to error. New hand starting…' });
    setTimeout(() => { if (activeGames.has(tableId) && game.canStartHand()) startNewHand(io, tableId, game); }, 3000);
  }, 15000);
}

function broadcastPttAdminState(io, tableId) {
  const muted    = tableMicMuted.get(tableId)  || new Set();
  const statuses = tableMicStatus.get(tableId) || new Map();
  const mode     = tablePttMode.get(tableId)   || 'ptt';
  const game     = activeGames.get(tableId);
  if (!game) return;
  const players = Array.from(game.players.values()).map(p => ({
    userId: p.userId, username: p.username, seatNumber: p.seatNumber,
    micStatus: statuses.get(p.userId) || 'idle',
    mutedByAdmin: muted.has(p.userId)
  }));
  for (const sid of getAdminSockets(io)) {
    io.to(sid).emit('ptt:admin_state', { tableId, players, mode });
  }
}

function setupSocketHandlers(io) {
  jackpotIo = io;
  loadJackpotFromDB();
  loadBannedUsersFromDB();
  startJackpotTimer(io);

  // Forward app-level events to admin sockets
  appEvents.on('player:registered', ({ userId, username }) => {
    for (const sid of getAdminSockets(io)) {
      io.to(sid).emit('admin:new_player', { userId, username });
    }
  });

  // Forward host grant/revoke to the affected player
  appEvents.on('host:change', ({ userId, isHost }) => {
    const sid = userSockets.get(userId);
    if (sid) {
      io.to(sid).emit(isHost ? 'you:host_granted' : 'you:host_revoked', {
        message: isHost
          ? 'You have been granted Host privileges by admin. You can now create tables and manage the room.'
          : 'Your Host privileges have been revoked by admin.'
      });
    }
  });

  // Immediate ban enforcement: return chips, notify, disconnect
  appEvents.on('player:banned', async ({ userId }) => {
    bannedUsers.add(userId);
    // Return chips from any active game
    for (const [tableId, game] of activeGames) {
      const player = game.getPlayer(userId);
      if (player) {
        const chipsToReturn = player.chips;
        game.removePlayer(userId);
        broadcastGameState(io, tableId, game);
        if (chipsToReturn > 0) {
          try {
            const { data } = await supabaseAdmin.from('users').select('chips').eq('id', userId).single();
            if (data) await supabaseAdmin.from('users').update({ chips: data.chips + chipsToReturn }).eq('id', userId);
          } catch {}
        }
      }
    }
    // Kick the socket
    const sid = userSockets.get(userId);
    if (sid) {
      io.to(sid).emit('banned', { message: 'Your account has been suspended. Contact admin at bostonspokerclub.amitureflops@gmail.com' });
      setTimeout(() => {
        const s = io.sockets.sockets.get(sid);
        if (s) s.disconnect(true);
      }, 500);
    }
    // Send suspension email to the banned player
    try {
      const { data: bannedUser } = await supabaseAdmin
        .from('users').select('email, username').eq('id', userId).single();
      if (bannedUser?.email) {
        await sendPlayerEmail({
          to: bannedUser.email,
          subject: 'Your Boston Poker Club account has been suspended',
          text: [
            `Hi ${bannedUser.username || 'there'},`,
            '',
            'Your Boston Poker Club account has been suspended.',
            '',
            'If you believe this is a mistake, please contact us to appeal:',
            'bostonspokerclub.amitureflops@gmail.com',
            '',
            '— Boston Poker Club'
          ].join('\n'),
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
              <h2 style="color:#c0392b">Account Suspended</h2>
              <p>Hi <strong>${bannedUser.username || 'there'}</strong>,</p>
              <p>Your <strong>Boston Poker Club</strong> account has been suspended.</p>
              <p>If you believe this is a mistake, please contact us to appeal:</p>
              <p><a href="mailto:bostonspokerclub.amitureflops@gmail.com" style="color:#1a7a3f">bostonspokerclub.amitureflops@gmail.com</a></p>
              <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
            </div>`
        });
      }
    } catch (e) {
      console.warn('[ban] Failed to send suspension email:', e.message);
    }
  });

  appEvents.on('player:unbanned', ({ userId }) => {
    bannedUsers.delete(userId);
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      if (bannedUsers.has(socket.user.id)) {
        return next(new Error('Your account has been suspended. Contact admin at bostonspokerclub.amitureflops@gmail.com'));
      }
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id: userId, username, isAdmin } = socket.user;
    socketUsers.set(socket.id, { userId, username, isAdmin });
    userSockets.set(userId, socket.id);

    socket.emit('jackpot_state', getAllJackpotState());

    // Deliver any queued broadcast messages for this player
    const queued = pendingMessages.get(userId);
    if (queued && queued.length) {
      for (const msg of queued) {
        socket.emit('broadcast_message', { ...msg, pending: true });
      }
      pendingMessages.delete(userId);
    }

    // ─── Table Events ──────────────────────────────────────────────────────

    socket.on('join_table', async ({ tableId, seatNumber, buyInChips }) => {
      try {
        // ── Reconnect shortcut: player already seated in this game ─────────
        // Must happen BEFORE any chip deduction or player removal.
        const existingGame = activeGames.get(tableId);
        if (existingGame) {
          const existingPlayer = existingGame.getPlayer(userId);
          if (existingPlayer) {
            existingPlayer.isConnected = true;
            socket.join(tableId);
            socket.currentTableId = tableId;
            socket.emit('joined_table', {
              tableId,
              tableName: existingGame.tableName || tableId,
              seatNumber: existingPlayer.seatNumber,
              chips: existingPlayer.chips,
              feltColor: existingGame.feltColor || '#1a5c2a'
            });
            broadcastGameState(io, tableId, existingGame);
            broadcastPuckState(io, tableId);
            // Re-send action prompt if it was their turn
            if (existingGame.handActive && existingGame.currentPlayerSeat === existingPlayer.seatNumber) {
              socket.emit('action_required', {
                seatNumber: existingPlayer.seatNumber,
                userId,
                callAmount: Math.max(0, existingGame.currentBet - existingPlayer.currentBet),
                pot: existingGame.pot
              });
            }
            // If this is a tournament table, send current tournament state
            if (tableId.startsWith('tournament_')) {
              const tournId = tableId.slice('tournament_'.length);
              const tourney = activeTournaments.get(tournId);
              if (tourney) {
                socket.emit('tournament_timer', tourney.getTimerState());
                socket.emit('tournament_standings', {
                  tournamentId: tournId,
                  standings: tourney.getStandings(),
                  prize: tourney.getTotalPrize(),
                  activePlayers: Array.from(tourney.players.values()).filter(p => !p.isEliminated).length
                });
              }
            }
            return;
          }
        }

        // ── Fresh join ────────────────────────────────────────────────────
        const { data: dbTable } = await supabaseAdmin
          .from('tables')
          .select('*')
          .eq('id', tableId)
          .single();

        // Fall back to config from existing in-memory game if Supabase unavailable
        const table = dbTable || (existingGame ? {
          id: tableId,
          game_type: existingGame.gameType,
          stakes_small_blind: existingGame.smallBlind,
          stakes_big_blind: existingGame.bigBlind,
          max_players: existingGame.maxPlayers,
          rake_percent: existingGame.rakePercent,
          status: 'active'
        } : null);

        if (!table) return socket.emit('error', { message: 'Table not found' });

        // Try with extended columns first; fall back to base columns if any don't exist yet
        let dbUser = null;
        {
          const { data: d1, error: e1 } = await supabaseAdmin
            .from('users')
            .select('id, chips, is_banned, email, phone, avatar_url, is_host, nickname')
            .eq('id', userId)
            .single();
          if (d1) {
            dbUser = d1;
          } else {
            console.warn(`[join_table] Extended user fetch failed for ${userId} (${e1?.message}) — retrying base columns`);
            const { data: d2, error: e2 } = await supabaseAdmin
              .from('users')
              .select('id, chips, is_banned, email, phone')
              .eq('id', userId)
              .single();
            if (d2) {
              dbUser = d2;
            } else {
              console.error(`[join_table] User ${userId} (${username}) not found after retry: ${e2?.message}`);
            }
          }
        }

        // Local admin bypass only — all real players must exist in DB
        const isLocalAdmin = userId === 'local-admin-000';
        if (!dbUser && !isLocalAdmin) {
          return socket.emit('error', { message: 'Account not found. Please log out and log in again.' });
        }
        const user = dbUser || { chips: 999999, is_banned: false };

        if (user.is_banned) return socket.emit('error', { message: 'Account is banned' });

        // ── Tournament table: chips are internal, no bank deduction ──────────
        const isTournamentTable = tableId.startsWith('tournament_');
        let chips;
        if (isTournamentTable) {
          const tournId = tableId.slice('tournament_'.length);
          const activeTourney = activeTournaments.get(tournId);
          const tp = activeTourney?.players.get(userId);

          if (!tp && !isAdmin && !isLocalAdmin) {
            return socket.emit('error', { message: 'You are not registered in this tournament' });
          }
          if (tp?.isEliminated) {
            return socket.emit('error', { message: 'You have been eliminated from this tournament' });
          }
          // Use player's current tournament chip stack; admin gets starting chips if unregistered
          chips = tp ? tp.chips : (activeTourney?.startingChips || 10000);
          // No bank deduction and no seat record for tournament tables
        } else {
          if (!isLocalAdmin && user.chips <= 0) {
            return socket.emit('error', { message: 'You have 0 chips. Contact the admin to receive chips before joining a table.' });
          }

          const minBuyIn = getMinBuyIn(table.stakes_small_blind, table.stakes_big_blind, table.game_type);
          chips = Math.max(buyInChips || minBuyIn, minBuyIn);

          if (!isLocalAdmin && user.chips < minBuyIn) {
            return socket.emit('error', { message: `Insufficient chips. Minimum buy-in for this table is $${minBuyIn}. Contact admin to add chips.` });
          }
          if (!isLocalAdmin && user.chips < chips) {
            return socket.emit('error', { message: `Insufficient chips. You need $${chips} to join with that buy-in.` });
          }
          if (!isLocalAdmin && chips < minBuyIn) {
            return socket.emit('error', { message: `Minimum buy-in for this table is $${minBuyIn}.` });
          }

          // Deduct chips from bank (only if user exists in DB)
          if (dbUser) {
            await supabaseAdmin.from('users').update({ chips: user.chips - chips }).eq('id', userId);
            logTransaction({ userId, username, type: 'table_buyin', amount: chips, tableName: table.name || tableId });
          }

          // Create or update seat record (best-effort — silently skip if DB unavailable)
          try {
            await supabaseAdmin.from('table_seats').upsert({
              table_id: tableId,
              user_id: userId,
              seat_number: seatNumber,
              chips_on_table: chips
            }, { onConflict: 'table_id,user_id' });
          } catch (_) {}
        }

        // Get or create game
        let game = activeGames.get(tableId);
        if (!game) {
          const { rakePercent, rakeCap } = getRakeConfig(table.stakes_small_blind, table.stakes_big_blind);
          game = new PokerGame({
            tableId,
            gameType: table.game_type,
            smallBlind: table.stakes_small_blind,
            bigBlind: table.stakes_big_blind,
            maxPlayers: table.max_players,
            rakePercent,
            rakeCap,
            jackpotFlatContrib: JACKPOT_CONTRIB,
            shotClockSeconds: SHOT_CLOCK
          });
          game.tableName = table.name || tableId;

          // Store host info on game for rake split attribution
          if (table.host_id) {
            try {
              const { data: hostUser } = await supabaseAdmin.from('users').select('username, is_admin, host_type').eq('id', table.host_id).single();
              if (hostUser) {
                game.hostId       = table.host_id;
                game.hostUsername = hostUser.username;
                game.hostType     = hostUser.is_admin ? 'admin' : (hostUser.host_type || 'host');
                game.hostPercent  = game.hostType === 'admin' ? 20 : 40;
              }
            } catch {}
          }

          game.feltColor = table.felt_color || '#1a5c2a';
          game.onBroadcast = (event, data) => io.to(tableId).emit(event, data);
          game.onPrivate = (uid, event, data) => {
            const sid = userSockets.get(uid);
            if (sid) io.to(sid).emit(event, data);
          };
          game.onHandEnd = (result) => persistHandResult(tableId, result);
          // High Hand Jackpot is Hold'em only — PLO tables do not participate
          if (table.game_type !== 'plo') {
            game.onJackpotCheck = (rank, uid, uname, desc) => checkTableJackpot(io, tableId, rank, uid, uname, desc);
            if (!tableJackpots.has(tableId)) {
              tableJackpots.set(tableId, {
                tableName: game.tableName,
                gameType: table.game_type || 'holdem',
                amount: 0,
                highHandRank: -1,
                highHandUserId: null,
                highHandUsername: null,
                highHandDescription: null,
                timerStart: Date.now(),
                isActive: false,
                isOnHold: false,
                awaitingPayout: false,
                pausedAt: null
              });
            }
          }
          game.onShotClockExpired = (uid) => {
            try {
              // Guard: only auto-fold if it is still this player's turn
              const currentPlayer = game.getPlayerBySeat(game.currentPlayerSeat);
              if (!currentPlayer || currentPlayer.userId !== uid) return;
              if (!game.handActive) return;
              const result = game.processAction(uid, 'fold');
              broadcastGameState(io, tableId, game);
              handleActionResult(io, tableId, game, result);
            } catch {}
          };

          activeGames.set(tableId, game);
          setupGameWatchdog(io, tableId, game);
        }

        const finalSeat = seatNumber || findOpenSeat(game, table.max_players);
        if (!finalSeat) return socket.emit('error', { message: 'No open seats' });

        game.addPlayer(userId, username, chips, finalSeat);
        playerProfiles.set(userId, { avatarUrl: dbUser?.avatar_url || null, isAdmin, isHost: dbUser?.is_host || false });

        // Increment sessions_played on first join to any table this session
        // Use a per-socket flag to avoid double-counting
        if (!socket._statsSessionCounted) {
          socket._statsSessionCounted = true;
          (async () => {
            try {
              const { data: ps } = await supabaseAdmin.from('player_stats').select('sessions_played').eq('user_id', userId).single();
              if (ps) {
                await supabaseAdmin.from('player_stats').update({ sessions_played: ps.sessions_played + 1, username, updated_at: new Date().toISOString() }).eq('user_id', userId);
              } else {
                await supabaseAdmin.from('player_stats').insert({ user_id: userId, username, sessions_played: 1 });
              }
            } catch {}
          })();
        }

        socket.join(tableId);
        socket.currentTableId = tableId;

        socket.emit('joined_table', { tableId, tableName: game.tableName || tableId, seatNumber: finalSeat, chips, feltColor: game.feltColor || '#1a5c2a' });
        broadcastGameState(io, tableId, game);

        // For tournament tables, send current tournament state to the joining player
        if (isTournamentTable) {
          const tournId = tableId.slice('tournament_'.length);
          const tourney = activeTournaments.get(tournId);
          if (tourney) {
            socket.emit('tournament_timer', tourney.getTimerState());
            socket.emit('tournament_standings', {
              tournamentId: tournId,
              standings: tourney.getStandings(),
              prize: tourney.getTotalPrize(),
              activePlayers: Array.from(tourney.players.values()).filter(p => !p.isEliminated).length
            });
          }
        }

        // SMS + email: notify player they are seated
        if (dbUser?.phone || dbUser?.email) {
          const seatedText = `Boston Poker Club: You have been seated at ${game.tableName || tableId}. Good luck!`;
          if (dbUser.phone) sendPlayerSMS({ phone: dbUser.phone, text: seatedText }).catch(() => {});
          if (dbUser.email) sendPlayerEmail({
            to: dbUser.email,
            subject: `You're seated at ${game.tableName || tableId} — Boston Poker Club`,
            text: seatedText,
            html: `<p>Hi <strong>${username}</strong>,</p><p>You have been seated at <strong>${game.tableName || tableId}</strong>.</p><p>Good luck at the tables!<br>— Boston Poker Club</p>`
          }).catch(() => {});
        }
        // Send current puck state to joining player
        broadcastPuckState(io, tableId);

        // Auto-start hand if enough players and no active hand
        if (!game.handActive && game.canStartHand()) {
          setTimeout(() => startNewHand(io, tableId, game), 2000);
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('leave_table', async ({ tableId }) => {
      await leaveTable(socket, io, tableId || socket.currentTableId, userId);
    });

    // ─── Table Waiting List ───────────────────────────────────────────────────

    socket.on('waitlist:join', async ({ tableId }) => {
      if (!tableId) return;
      if (!tableWaitlists.has(tableId)) tableWaitlists.set(tableId, []);
      const list = tableWaitlists.get(tableId);

      // Already in list?
      if (list.some(e => e.userId === userId)) {
        const pos = list.findIndex(e => e.userId === userId) + 1;
        return socket.emit('waitlist:position', { tableId, position: pos, total: list.length });
      }

      // Also fetch phone for SMS notifications
      const { data: dbUser } = await supabaseAdmin.from('users').select('phone').eq('id', userId).single();
      list.push({ userId, username, phone: dbUser?.phone || null, socketId: socket.id, joinedAt: Date.now() });
      socket.join(`${tableId}:waitlist`);

      const pos = list.length;
      socket.emit('waitlist:joined', { tableId, position: pos, total: list.length });

      // Notify admins
      _broadcastWaitlistUpdate(io, tableId);
    });

    socket.on('waitlist:leave', ({ tableId }) => {
      const tId = tableId || socket.currentTableId;
      if (!tId) return;
      const list = tableWaitlists.get(tId) || [];
      const idx = list.findIndex(e => e.userId === userId);
      if (idx !== -1) {
        list.splice(idx, 1);
        socket.leave(`${tId}:waitlist`);
        socket.emit('waitlist:left', { tableId: tId });
        _broadcastWaitlistUpdate(io, tId);
        // Re-broadcast positions to remaining waiters
        list.forEach((entry, i) => {
          io.to(entry.socketId).emit('waitlist:position', { tableId: tId, position: i + 1, total: list.length });
        });
      }
    });

    socket.on('waitlist:get', ({ tableId }) => {
      const tId = tableId || socket.currentTableId;
      if (!tId) return;
      const list = tableWaitlists.get(tId) || [];
      const pos = list.findIndex(e => e.userId === userId) + 1;
      socket.emit('waitlist:position', { tableId: tId, position: pos > 0 ? pos : null, total: list.length });
    });

    // Admin: view or manage a table's waitlist
    socket.on('waitlist:admin_view', ({ tableId }) => {
      if (!isAdmin) return;
      const list = (tableWaitlists.get(tableId) || []).map((e, i) => ({
        position: i + 1, userId: e.userId, username: e.username,
        joinedAt: e.joinedAt
      }));
      socket.emit('waitlist:admin_data', { tableId, list });
    });

    socket.on('waitlist:admin_remove', ({ tableId, userId: removeId }) => {
      if (!isAdmin) return;
      const list = tableWaitlists.get(tableId) || [];
      const idx = list.findIndex(e => e.userId === removeId);
      if (idx !== -1) {
        const removed = list.splice(idx, 1)[0];
        io.to(removed.socketId).emit('waitlist:removed', { tableId, reason: 'Removed by admin' });
        io.sockets.sockets.get(removed.socketId)?.leave(`${tableId}:waitlist`);
        list.forEach((entry, i) => {
          io.to(entry.socketId).emit('waitlist:position', { tableId, position: i + 1, total: list.length });
        });
        _broadcastWaitlistUpdate(io, tableId);
      }
    });

    socket.on('player_action', ({ tableId, action, amount }) => {
      const tId = tableId || socket.currentTableId;
      const game = activeGames.get(tId);
      if (!game) return socket.emit('error', { message: 'Game not found' });

      try {
        console.log(`[action] ${username} → ${action}${amount ? ' $'+amount : ''} | hand#${game.handNumber} street:${game.currentStreet} seat:${game.currentPlayerSeat}`);
        const result = game.processAction(userId, action, amount);
        game.lastActionAt = Date.now();
        broadcastGameState(io, tId, game);
        handleActionResult(io, tId, game, result);
        // Notify other players at the table so they can play a sound
        const actingPlayer = game.getPlayer(userId);
        socket.to(tId).emit('player_acted', {
          action, amount: amount || 0, username,
          isAllIn: actingPlayer?.isAllIn || false
        });
      } catch (err) {
        console.warn(`[action] error for ${username}: ${err.message}`);
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('request_break', ({ tableId }) => {
      const game = activeGames.get(tableId || socket.currentTableId);
      if (!game) return;
      try {
        const result = game.requestBreak(userId);
        socket.emit('break_granted', result);
        broadcastGameState(io, tableId || socket.currentTableId, game);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('return_from_break', ({ tableId }) => {
      const game = activeGames.get(tableId || socket.currentTableId);
      if (!game) return;
      try {
        const result = game.returnFromBreak(userId);
        socket.emit('break_ended', result);
        broadcastGameState(io, tableId || socket.currentTableId, game);
        if (!game.handActive && game.canStartHand()) {
          setTimeout(() => startNewHand(io, tableId || socket.currentTableId, game), 1000);
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('chat_message', ({ tableId, message }) => {
      if (socket.spectatingTableId) return; // spectators are invisible — never broadcast their chat
      const tId = tableId || socket.currentTableId;
      if (!message || message.length > 200) return;
      io.to(tId).emit('chat', {
        userId,
        username,
        message: message.trim(),
        timestamp: Date.now()
      });
    });

    // ─── WebRTC PTT ───────────────────────────────────────────────────────

    // Player joins the PTT mesh: send them the peer list, tell others about them
    socket.on('ptt:mesh_join', () => {
      const tId = socket.currentTableId;
      if (!tId) {
        console.log(`[PTT] ${username} ptt:mesh_join but no currentTableId — ignoring`);
        return;
      }
      const sids = io.sockets.adapter.rooms.get(tId) || new Set();
      const peers = [];
      for (const sid of sids) {
        const peer = socketUsers.get(sid);
        if (peer && peer.userId !== userId) {
          peers.push({ userId: peer.userId, username: peer.username });
        }
      }
      // Joiner creates offers to all existing peers
      socket.emit('ptt:mesh_peers', { peers });
      // Tell existing peers about the new joiner (they wait for offers from them)
      socket.to(tId).emit('ptt:new_peer', { userId, username });
      console.log(`[PTT] ${username} joined mesh on ${tId} — ${peers.length} existing peer(s)`);
    });

    // Relay WebRTC signaling (offer / answer / ICE)
    socket.on('ptt:signal', ({ targetUserId, signal }) => {
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) {
        io.to(targetSid).emit('ptt:signal', { fromUserId: userId, signal });
      } else {
        console.warn(`[PTT] signal relay failed: no socket for targetUserId=${targetUserId} type=${signal.type}`);
      }
    });

    // Player unmuted (actively talking)
    socket.on('ptt:talking', () => {
      const tId = socket.currentTableId;
      if (!tId) return;
      socket.to(tId).emit('ptt:speaker_active', { userId, username });
      if (!tableMicStatus.has(tId)) tableMicStatus.set(tId, new Map());
      tableMicStatus.get(tId).set(userId, 'speaking');
      broadcastPttAdminState(io, tId);
    });

    // Player muted (released PTT)
    socket.on('ptt:silent', () => {
      const tId = socket.currentTableId;
      if (!tId) return;
      socket.to(tId).emit('ptt:speaker_stopped', { userId });
      if (tableMicStatus.has(tId)) {
        tableMicStatus.get(tId).set(userId, 'idle');
        broadcastPttAdminState(io, tId);
      }
    });

    // Player reports mic status — forwarded to admins
    socket.on('ptt:mic_status', ({ status }) => {
      const tId = socket.currentTableId;
      if (!tId) return;
      if (!tableMicStatus.has(tId)) tableMicStatus.set(tId, new Map());
      tableMicStatus.get(tId).set(userId, status || 'idle');
      broadcastPttAdminState(io, tId);
    });

    // Admin: mute a specific player's mic
    socket.on('ptt:admin_mute', ({ targetUserId }) => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      if (!tableMicMuted.has(tId)) tableMicMuted.set(tId, new Set());
      tableMicMuted.get(tId).add(targetUserId);
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('ptt:muted_by_admin', { message: 'Your mic has been muted by admin' });
      broadcastPttAdminState(io, tId);
    });

    // Admin: unmute a specific player's mic
    socket.on('ptt:admin_unmute', ({ targetUserId }) => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      tableMicMuted.get(tId)?.delete(targetUserId);
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('ptt:unmuted_by_admin', {});
      broadcastPttAdminState(io, tId);
    });

    // Admin: mute all players (admin's own mic is unaffected)
    socket.on('ptt:admin_mute_all', () => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      const game = activeGames.get(tId);
      if (!game) return;
      if (!tableMicMuted.has(tId)) tableMicMuted.set(tId, new Set());
      const muted = tableMicMuted.get(tId);
      for (const [uid] of game.players) {
        if (uid === userId) continue;
        muted.add(uid);
        const targetSid = userSockets.get(uid);
        if (targetSid) io.to(targetSid).emit('ptt:muted_by_admin', { message: 'Your mic has been muted by admin' });
      }
      broadcastPttAdminState(io, tId);
    });

    // Admin: unmute all players
    socket.on('ptt:admin_unmute_all', () => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      const game = activeGames.get(tId);
      if (!game) return;
      tableMicMuted.get(tId)?.clear();
      for (const [uid] of game.players) {
        const targetSid = userSockets.get(uid);
        if (targetSid) io.to(targetSid).emit('ptt:unmuted_by_admin', {});
      }
      broadcastPttAdminState(io, tId);
    });

    // Admin: switch between PTT and open-mic mode
    socket.on('ptt:admin_set_mode', ({ mode }) => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId || (mode !== 'ptt' && mode !== 'openmic')) return;
      tablePttMode.set(tId, mode);
      io.to(tId).emit('ptt:mode_change', { mode });
      broadcastPttAdminState(io, tId);
    });

    // ─── Camera state ─────────────────────────────────────────────────────────

    // Broadcast camera on/off to the rest of the table
    socket.on('cam:state_change', ({ enabled }) => {
      const tId = socket.currentTableId;
      if (!tId) return;
      socket.to(tId).emit('cam:state_change', { userId, username, enabled: !!enabled });
    });

    // Admin: turn off a specific player's camera
    socket.on('cam:admin_disable', ({ targetUserId }) => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('cam:disabled_by_admin', {});
    });

    // Admin: turn off all cameras at this table
    socket.on('cam:admin_disable_all', () => {
      if (!isAdmin) return;
      const tId = socket.currentTableId;
      if (!tId) return;
      io.to(tId).emit('cam:disabled_by_admin', {});
    });

    // ─── Admin Spectator Mode ────────────────────────────────────────────────

    socket.on('admin:spectate', ({ tableId: tId }) => {
      if (!isAdmin) return;
      socket.join(tId);
      socket.spectatingTableId = tId;
      if (!tableSpectators.has(tId)) tableSpectators.set(tId, new Set());
      tableSpectators.get(tId).add(socket.id);

      // For tournament tables, also look up the game from the tournament object if not in activeGames yet
      let game = activeGames.get(tId);
      if (!game && tId.startsWith('tournament_')) {
        const tournId = tId.slice('tournament_'.length);
        game = activeTournaments.get(tournId)?.game || null;
      }

      if (game) {
        socket.emit('spectator_state', _buildGodState(game));
        socket.emit('spectator_joined', { tableId: tId, tableName: game.tableName || tId, feltColor: game.feltColor || '#1a5c2a' });
      } else {
        socket.emit('spectator_joined', { tableId: tId, tableName: tId, feltColor: '#1a5c2a' });
      }

      // Send tournament state if applicable
      if (tId.startsWith('tournament_')) {
        const tournId = tId.slice('tournament_'.length);
        const tourney = activeTournaments.get(tournId);
        if (tourney) {
          socket.emit('tournament_timer', tourney.getTimerState());
          socket.emit('tournament_standings', {
            tournamentId: tournId,
            standings: tourney.getStandings(),
            prize: tourney.getTotalPrize(),
            activePlayers: Array.from(tourney.players.values()).filter(p => !p.isEliminated).length
          });
        }
      }

      console.log(`[spectate] admin ${username} spectating ${tId}`);
    });

    socket.on('admin:leave_spectate', () => {
      if (!isAdmin) return;
      const tId = socket.spectatingTableId;
      if (tId) {
        tableSpectators.get(tId)?.delete(socket.id);
        socket.leave(tId);
        socket.spectatingTableId = null;
        // No broadcast to players — admin exit is silent
      }
    });

    socket.on('admin:get_overview', () => {
      if (!isAdmin) return;
      socket.emit('admin:overview', buildTableOverview());
    });

    socket.on('admin:cam_presence', ({ enabled }) => {
      if (!isAdmin) return;
      const tId = socket.spectatingTableId;
      if (!tId) return;
      socket.to(tId).emit('admin:cam_presence', { userId, username, enabled: !!enabled });
      if (enabled) socket.to(tId).emit('ptt:new_peer', { userId, username });
    });

    // ─── Host Actions ─────────────────────────────────────────────────────

    socket.on('host:add_chips', async ({ targetUserId, amount }) => {
      if (!hostSet.has(userId) && !isAdmin) return socket.emit('error', { message: 'Host access required' });
      if (!amount || amount <= 0) return socket.emit('error', { message: 'Amount must be positive' });

      // Budget check for non-admin hosts
      if (!isAdmin) {
        try {
          const { data: hostData } = await supabaseAdmin
            .from('users').select('host_chip_budget, host_chips_used').eq('id', userId).single();
          const budget = hostData?.host_chip_budget || 0;
          const used   = hostData?.host_chips_used   || 0;
          if (budget > 0 && (used + amount) > budget) {
            return socket.emit('error', {
              message: `Budget exceeded. You have $${(budget - used).toLocaleString()} remaining of your $${budget.toLocaleString()} budget.`
            });
          }
          // Update chips used
          await supabaseAdmin.from('users')
            .update({ host_chips_used: used + amount }).eq('id', userId);
        } catch (budgetErr) {
          console.warn('[host:add_chips] budget check failed:', budgetErr.message);
        }
      }

      const tId = socket.currentTableId;
      const game = tId ? activeGames.get(tId) : null;

      if (game) {
        const player = game.getPlayer(targetUserId);
        if (!player) return socket.emit('error', { message: 'Player not at this table' });
        player.chips += amount;
        broadcastGameState(io, tId, game);
      }

      // Log transaction with actor info
      logTransaction({
        userId: targetUserId,
        username: '',
        type: 'host_add_chips',
        amount,
        tableName: game?.tableName || tId || null,
        notes: JSON.stringify({ actorId: userId, actorName: username })
      });

      // Persist to DB and notify player
      try {
        const { data: pu } = await supabaseAdmin.from('users').select('chips, phone, email, username').eq('id', targetUserId).single();
        if (pu) {
          await supabaseAdmin.from('users').update({ chips: pu.chips + amount }).eq('id', targetUserId);
          const notifText = `Boston Poker Club: $${amount.toLocaleString()} chips added to your account by ${username}. You can now join a table!`;
          const notifHtml = `<p>Hi <strong>${pu.username || 'there'}</strong>,</p><p><strong>$${amount.toLocaleString()} chips</strong> have been added to your account by <strong>${username}</strong>.</p><p>New balance: <strong>$${(pu.chips + amount).toLocaleString()}</strong> chips.</p><p>Good luck at the tables!<br>— Boston Poker Club</p>`;
          if (pu.phone) sendPlayerSMS({ phone: pu.phone, text: notifText }).catch(() => {});
          if (pu.email) sendPlayerEmail({ to: pu.email, subject: `$${amount.toLocaleString()} chips added — Boston Poker Club`, text: notifText, html: notifHtml }).catch(() => {});
        }
      } catch {}

      console.log(`[host:add_chips] ${username} (${isAdmin ? 'admin' : 'host'}) added ${amount} chips to user ${targetUserId}`);
      socket.emit('chips_added', { targetUserId, amount, by: username });
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('chips_received', { amount, from: username });
    });

    // ─── Game Pause / Resume ──────────────────────────────────────────────

    socket.on('host:pause_game', ({ tableId: tId, reason }) => {
      const tIdFinal = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = tIdFinal ? activeGames.get(tIdFinal) : null;
      if (!game) return socket.emit('error', { message: 'No active game' });

      game.isPaused    = true;
      game.pauseReason = reason || null;
      game.pausedAt    = Date.now();
      game.pausedBy    = username;

      broadcastGameState(io, tIdFinal, game);
      io.to(tIdFinal).emit('game_paused', { reason: reason || null, by: username });
      io.to(tIdFinal).emit('chat', { username: 'system', message: `⏸ Game paused by ${username}${reason ? `: "${reason}"` : ''}. Current hand will finish; no new hands until resumed.` });
      console.log(`[pause] ${tIdFinal} paused by ${username}: ${reason || '(no reason)'}`);
    });

    socket.on('host:resume_game', ({ tableId: tId }) => {
      const tIdFinal = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = tIdFinal ? activeGames.get(tIdFinal) : null;
      if (!game) return socket.emit('error', { message: 'No active game' });

      game.isPaused    = false;
      game.pauseReason = null;
      game.pausedAt    = null;
      game.pausedBy    = null;

      broadcastGameState(io, tIdFinal, game);
      io.to(tIdFinal).emit('game_resumed', { by: username });
      io.to(tIdFinal).emit('chat', { username: 'system', message: `▶️ Game resumed by ${username}. New hands will deal normally.` });
      console.log(`[pause] ${tIdFinal} resumed by ${username}`);

      // Auto-start if no hand running
      if (!game.handActive && game.canStartHand()) {
        setTimeout(() => startNewHand(io, tIdFinal, game), 2000);
      }
    });

    // ─── Money Puck Events ────────────────────────────────────────────────

    socket.on('puck:drop', ({ tableId: tId, startValue, autoDropMinutes }) => {
      const tIdFinal = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = activeGames.get(tIdFinal);
      if (!game) return socket.emit('error', { message: 'No active game at this table' });

      const seatedPlayers = Array.from(game.players.values()).sort((a, b) => a.seatNumber - b.seatNumber);
      if (!seatedPlayers.length) return socket.emit('error', { message: 'No players seated' });

      // Assign to current dealer or first player
      const dealerPlayer = game.getPlayerBySeat(game.dealerSeat) || seatedPlayers[0];

      // Clear existing puck for this table
      const existing = tablePucks.get(tIdFinal);
      if (existing) {
        if (existing.straddleTimeout) clearTimeout(existing.straddleTimeout);
        if (existing.autoDropTimer)   clearInterval(existing.autoDropTimer);
      }

      const autoDropMs = (autoDropMinutes || 0) * 60 * 1000;
      const puck = {
        holderId: dealerPlayer.userId,
        holderSeat: dealerPlayer.seatNumber,
        holderName: dealerPlayer.username,
        value: Math.max(1, startValue || 15),
        autoDropMs,
        autoDropTimer: null,
        straddleTimeout: null
      };
      tablePucks.set(tIdFinal, puck);

      if (autoDropMs > 0) {
        puck.autoDropTimer = setInterval(() => passMoneyPuck(io, tIdFinal, game), autoDropMs);
      }

      broadcastPuckState(io, tIdFinal);
      io.to(tIdFinal).emit('chat', { username: 'system', message: `💰 Money Puck dropped to ${dealerPlayer.username} (value: $${puck.value})` });
    });

    socket.on('puck:straddle_response', ({ tableId: tId, accepted }) => {
      const tIdFinal = tId || socket.currentTableId;
      const puck = tablePucks.get(tIdFinal);
      if (!puck || puck.holderId !== userId) return;

      if (puck.straddleTimeout) { clearTimeout(puck.straddleTimeout); puck.straddleTimeout = null; }

      const game = activeGames.get(tIdFinal);
      if (!game) return;

      if (accepted) {
        const player = game.getPlayer(userId);
        if (player && player.chips >= puck.value) {
          player.chips -= puck.value;
          game.pot += puck.value;
          puck.value += 15;
          broadcastGameState(io, tIdFinal, game);
          broadcastPuckState(io, tIdFinal);
          io.to(tIdFinal).emit('chat', { username: 'system', message: `💰 ${player.username} posted $${puck.value - 15} straddle! Puck value now $${puck.value}` });
        } else {
          // Can't afford — pass it
          passMoneyPuck(io, tIdFinal, game);
        }
      } else {
        passMoneyPuck(io, tIdFinal, game);
      }
    });

    socket.on('puck:pass', ({ tableId: tId }) => {
      const tIdFinal = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = activeGames.get(tIdFinal);
      if (game) passMoneyPuck(io, tIdFinal, game);
    });

    socket.on('puck:clear', ({ tableId: tId }) => {
      const tIdFinal = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const puck = tablePucks.get(tIdFinal);
      if (puck) {
        if (puck.straddleTimeout) clearTimeout(puck.straddleTimeout);
        if (puck.autoDropTimer)   clearInterval(puck.autoDropTimer);
      }
      tablePucks.delete(tIdFinal);
      broadcastPuckState(io, tIdFinal);
      io.to(tIdFinal).emit('chat', { username: 'system', message: '💰 Money Puck removed' });
    });

    // ─── Cashout Flow ─────────────────────────────────────────────────────

    socket.on('cashout_request', async ({ tableId: tId }) => {
      const tIdFinal = tId || socket.currentTableId;
      const game = tIdFinal ? activeGames.get(tIdFinal) : null;
      const chips = game?.getPlayer(userId)?.chips || 0;
      const tableName = game?.tableName || tIdFinal || 'unknown';

      // Return chips to DB
      if (chips > 0) {
        try {
          const { data: u } = await supabaseAdmin.from('users').select('chips').eq('id', userId).single();
          if (u) await supabaseAdmin.from('users').update({ chips: u.chips + chips }).eq('id', userId);
          logTransaction({ userId, username, type: 'cashout', amount: chips, tableName });
        } catch {}
      }

      // Remove from game
      if (game) {
        const puck = tablePucks.get(tIdFinal);
        if (puck && puck.holderId === userId) passMoneyPuck(io, tIdFinal, game);
        game.removePlayer(userId);
        broadcastGameState(io, tIdFinal, game);
        if (game.players.size === 0) { game.destroy(); activeGames.delete(tIdFinal); }
        try { await supabaseAdmin.from('table_seats').delete().eq('table_id', tIdFinal).eq('user_id', userId); } catch {}
      }

      socket.leave(tIdFinal);
      socket.currentTableId = null;
      socket.emit('cashout_confirmed', { chips, tableId: tIdFinal });

      // Notify admins
      pushAdminNotif(io, {
        type: 'cashout',
        title: 'Player Cashing Out',
        body: `${username} cashed out $${chips.toLocaleString()} chips from ${tableName}`,
        data: { userId, username, chips, tableId: tIdFinal, tableName }
      });
      sendAdminPush(
        `Cashout: ${username} cashed out $${chips.toLocaleString()} chips from ${tableName}.`,
        'Player Cashout'
      ).catch(() => {});
    });

    // ─── Rail / Waiting Room ──────────────────────────────────────────────

    socket.on('rail:join', async ({ buyin }) => {
      // Remove existing entry if re-joining
      const existing = railQueue.findIndex(r => r.userId === userId);
      if (existing !== -1) railQueue.splice(existing, 1);

      // Fetch profile for display
      let profile = { nickname: null, phone: null };
      try {
        const { data } = await supabaseAdmin.from('users').select('nickname, phone').eq('id', userId).single();
        if (data) profile = data;
      } catch {}

      railQueue.push({ userId, username, nickname: profile.nickname, phone: profile.phone, requestedBuyin: buyin || 0, requestedAt: Date.now(), socketId: socket.id });
      socket.emit('rail:position', { position: railQueue.length, total: railQueue.length });
      socket.join('rail');

      pushAdminNotif(io, {
        type: 'rail_join',
        title: 'Player Joined Rail',
        body: `${username}${profile.nickname ? ` (${profile.nickname})` : ''} is waiting for a seat (buy-in: $${(buyin || 0).toLocaleString()})`,
        data: { userId, username, buyin }
      });
      sendAdminPush(
        `Buy-in request: ${username}${profile.nickname ? ` (${profile.nickname})` : ''} wants $${(buyin || 0).toLocaleString()} chips.`,
        'Buy-In Request'
      ).catch(() => {});

      // Broadcast updated queue positions to all in rail
      railQueue.forEach((entry, i) => {
        const sid = userSockets.get(entry.userId);
        if (sid) io.to(sid).emit('rail:position', { position: i + 1, total: railQueue.length });
      });

      // Notify admins of updated rail
      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:rail_update', { queue: railQueue.map(r => ({ ...r, socketId: undefined })) });
      }
    });

    socket.on('rail:approve', async ({ targetUserId, amount }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      const idx = railQueue.findIndex(r => r.userId === targetUserId);
      if (idx === -1) return socket.emit('error', { message: 'Player not in rail' });
      const entry = railQueue[idx];
      railQueue.splice(idx, 1);

      // Grant chips
      try {
        const { data: u } = await supabaseAdmin.from('users').select('chips').eq('id', targetUserId).single();
        if (u) await supabaseAdmin.from('users').update({ chips: u.chips + amount }).eq('id', targetUserId);
      } catch {}

      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('rail:approved', { amount, message: `Admin approved $${amount.toLocaleString()} chips! You can now join a table.` });

      // Update remaining positions
      railQueue.forEach((r, i) => {
        const sid = userSockets.get(r.userId);
        if (sid) io.to(sid).emit('rail:position', { position: i + 1, total: railQueue.length });
      });

      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:rail_update', { queue: railQueue.map(r => ({ ...r, socketId: undefined })) });
      }
    });

    socket.on('rail:deny', ({ targetUserId, reason }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      const idx = railQueue.findIndex(r => r.userId === targetUserId);
      if (idx !== -1) railQueue.splice(idx, 1);

      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('rail:denied', { message: reason || 'Your seat request was declined by admin.' });

      railQueue.forEach((r, i) => {
        const sid = userSockets.get(r.userId);
        if (sid) io.to(sid).emit('rail:position', { position: i + 1, total: railQueue.length });
      });

      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:rail_update', { queue: railQueue.map(r => ({ ...r, socketId: undefined })) });
      }
    });

    socket.on('rail:leave', () => {
      const idx = railQueue.findIndex(r => r.userId === userId);
      if (idx !== -1) railQueue.splice(idx, 1);
      socket.leave('rail');
      railQueue.forEach((r, i) => {
        const sid = userSockets.get(r.userId);
        if (sid) io.to(sid).emit('rail:position', { position: i + 1, total: railQueue.length });
      });
    });

    // ─── Chat Extras (clear, reactions, stickers) ─────────────────────────

    socket.on('chat:clear', () => {
      const tId = socket.currentTableId;
      if (!tId || (!isAdmin && !hostSet.has(userId))) return;
      io.to(tId).emit('chat:cleared', { by: username });
    });

    socket.on('chat_reaction', ({ tableId: tId, emoji }) => {
      const finalTId = tId || socket.currentTableId;
      if (!finalTId || !emoji) return;
      const allowed = ['😂', '🔥', '💰', '😤', '🤙'];
      if (!allowed.includes(emoji)) return;
      io.to(finalTId).emit('chat_reaction', { userId, username, emoji });
    });

    // ─── Rabbit Hunt ──────────────────────────────────────────────────────

    socket.on('host:toggle_rabbit', ({ tableId: tId, enabled }) => {
      const finalTId = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = activeGames.get(finalTId);
      if (!game) return socket.emit('error', { message: 'No active game' });
      game.rabbitHuntEnabled = !!enabled;
      broadcastGameState(io, finalTId, game);
      io.to(finalTId).emit('chat', { username: 'system', message: `🐇 Rabbit Hunt ${enabled ? 'enabled' : 'disabled'}` });
    });

    socket.on('rabbit:run', ({ tableId: tId }) => {
      const finalTId = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const data = tableRabbitData.get(finalTId);
      if (!data) return socket.emit('error', { message: 'No rabbit hunt data — only available after a fold win' });
      io.to(finalTId).emit('rabbit:result', data);
      tableRabbitData.delete(finalTId);
    });

    // ─── Straddle ─────────────────────────────────────────────────────────

    socket.on('host:toggle_straddle', ({ tableId: tId, enabled }) => {
      const finalTId = tId || socket.currentTableId;
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host or admin required' });
      const game = activeGames.get(finalTId);
      if (!game) return socket.emit('error', { message: 'No active game' });
      game.straddleEnabled = !!enabled;
      broadcastGameState(io, finalTId, game);
      io.to(finalTId).emit('chat', { username: 'system', message: `🎯 UTG Straddle ${enabled ? 'enabled' : 'disabled'}` });
    });

    socket.on('straddle:respond', ({ tableId: tId, accepted }) => {
      const finalTId = tId || socket.currentTableId;
      const game = activeGames.get(finalTId);
      if (!game) return;

      if (game._straddleTimer) { clearTimeout(game._straddleTimer); game._straddleTimer = null; }
      game._straddleOffered = false;

      if (accepted) {
        try {
          const result = game.acceptStraddle(userId);
          broadcastGameState(io, finalTId, game);
          io.to(finalTId).emit('chat', { username: 'system', message: `🎯 ${username} posted straddle ($${result.straddleAmount})` });
        } catch (err) {
          console.error('[straddle] acceptStraddle failed:', err.message);
        }
      }

      _postStraddleAction(io, finalTId, game);
    });

    // ─── Table Stats ──────────────────────────────────────────────────────

    socket.on('table:get_stats', ({ tableId: tId }) => {
      const finalTId = tId || socket.currentTableId;
      socket.emit('table:stats', { tableId: finalTId, ...getTableStats(finalTId) });
    });

    // ─── Host Table Requests ──────────────────────────────────────────────

    socket.on('table:request', ({ tableName, gameType, sb, bb, maxPlayers, rake }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host access required' });
      const displayName = (tableName || '').trim() || `${username}'s Table`;
      const req = {
        id: ++tableRequestSeq,
        hostId: userId,
        hostName: username,
        tableName: displayName,
        gameType: gameType || 'holdem',
        sb: sb || 5,
        bb: bb || 10,
        maxPlayers: maxPlayers || 9,
        rake: rake || 5,
        requestedAt: Date.now(),
        status: 'pending'
      };
      tableRequests.unshift(req);
      if (tableRequests.length > 50) tableRequests.pop();
      socket.emit('table:request_submitted', { requestId: req.id });

      const gameLabel = req.gameType === 'plo' ? 'PLO' : "Hold'em";
      pushAdminNotif(io, {
        type: 'table_request',
        title: 'Table Request',
        body: `${username} requests "${displayName}" — $${req.sb}/$${req.bb} ${gameLabel}`,
        data: { requestId: req.id, hostId: userId, hostName: username, tableName: displayName }
      });

      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:table_request', req);
      }

      // Email notification (non-blocking)
      sendTableRequestEmail({
        hostName: username,
        tableName: displayName,
        gameType: req.gameType,
        sb: req.sb,
        bb: req.bb,
        maxPlayers: req.maxPlayers,
        rake: req.rake
      }).catch(() => {});
    });

    socket.on('table:request_action', async ({ requestId, action, reason }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      const req = tableRequests.find(r => r.id === requestId);
      if (!req) return socket.emit('error', { message: 'Request not found' });
      req.status = action; // 'approved' or 'denied'

      const hostSid = userSockets.get(req.hostId);
      const gameLabel = req.gameType === 'plo' ? 'PLO' : "Hold'em";
      const tableName = req.tableName || `${req.hostName}'s Table`;

      if (action === 'approved') {
        // Create the table in DB
        try {
          const { data } = await supabaseAdmin.from('tables').insert({
            name: tableName,
            game_type: req.gameType,
            stakes_small_blind: req.sb,
            stakes_big_blind: req.bb,
            max_players: req.maxPlayers,
            rake_percent: req.rake,
            status: 'active',
            created_by: req.hostId
          }).select('id').single();
          req.tableId = data?.id;
        } catch (e) { req.error = e.message; }

        if (hostSid) io.to(hostSid).emit('table:request_approved', {
          requestId,
          tableId: req.tableId,
          tableName,
          message: `Your table "${tableName}" ($${req.sb}/$${req.bb} ${gameLabel}) was approved! It is now live in the lobby.`
        });

        // Notify all connected players that a new table opened
        io.emit('tables:updated');
      } else {
        if (hostSid) io.to(hostSid).emit('table:request_denied', {
          requestId,
          tableName,
          message: reason
            ? `Your table request for "${tableName}" was denied: ${reason}`
            : `Your table request for "${tableName}" was denied by admin.`
        });
      }

      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:table_request_update', req);
      }
    });

    socket.on('lobby:join', () => {
      // Player is in the lobby — notify admins
      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:player_in_lobby', { userId, username });
      }
    });

    // ─── Broadcast Messaging ──────────────────────────────────────────────
    socket.on('admin:send_message', async ({ targetUserId, message }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      if (!message || !message.trim()) return;

      const msg = {
        id: ++broadcastMsgSeq,
        from: username,
        message: message.trim().slice(0, 500),
        targetUserId: targetUserId || null,
        targetAll: !targetUserId,
        sentAt: Date.now()
      };

      broadcastMessages.unshift(msg);
      if (broadcastMessages.length > 200) broadcastMessages.pop();

      // Count total connected sockets (all users, all pages)
      const totalSockets = io.sockets.sockets.size;
      console.log(`[broadcast] admin "${username}" → ${targetUserId ? 'user ' + targetUserId : 'ALL'} | ${totalSockets} sockets connected`);

      let delivered = 0;
      let queued = 0;

      if (targetUserId) {
        // Targeted message — find any socket belonging to this user
        let sent = false;
        for (const [sid, s] of io.sockets.sockets) {
          if (s.user && s.user.id === targetUserId) {
            s.emit('broadcast_message', msg);
            console.log(`[broadcast] targeted → uid=${targetUserId} sid=${sid}`);
            delivered++;
            sent = true;
          }
        }
        if (!sent) {
          if (!pendingMessages.has(targetUserId)) pendingMessages.set(targetUserId, []);
          pendingMessages.get(targetUserId).push(msg);
          queued++;
          console.log(`[broadcast] queued for offline uid=${targetUserId}`);
        }
      } else {
        // Broadcast to ALL sockets except the sending admin's own socket
        // Use io.emit() which hits every connected socket regardless of room/page
        const adminSid = socket.id;
        for (const [sid, s] of io.sockets.sockets) {
          if (sid === adminSid) continue; // don't echo back to self
          if (s.user) {
            s.emit('broadcast_message', msg);
            console.log(`[broadcast] → uid=${s.user.id} (${s.user.username}) sid=${sid}`);
            delivered++;
          }
        }
        // Queue for offline users and send emails
        try {
          const { data: allUsers } = await supabaseAdmin.from('users').select('id, email, username').eq('is_banned', false);
          const onlineIds = new Set();
          for (const [, s] of io.sockets.sockets) {
            if (s.user) onlineIds.add(s.user.id);
          }
          const offlineUsers = (allUsers || []).filter(u => !onlineIds.has(u.id) && u.id !== userId);
          for (const u of offlineUsers) {
            if (!pendingMessages.has(u.id)) pendingMessages.set(u.id, []);
            pendingMessages.get(u.id).push(msg);
            queued++;
          }
          const emailRecipients = (allUsers || []).filter(u => u.email && u.id !== userId);
          if (emailRecipients.length > 0) {
            sendBroadcastEmail({ from: username, message: msg.message, recipients: emailRecipients }).catch(() => {});
          }
        } catch (e) {
          console.warn('[broadcast] DB query failed for offline queue:', e.message);
        }
      }

      console.log(`[broadcast] done — delivered: ${delivered}, queued: ${queued}`);
      socket.emit('admin:message_sent', { id: msg.id, delivered, queued, total: delivered + queued });

      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:message_history', { messages: broadcastMessages.slice(0, 50) });
      }
    });

    socket.on('messages:get', () => {
      socket.emit('messages:list', { messages: broadcastMessages.slice(0, 100) });
    });

    // Player replies to admin messages
    socket.on('player:reply', ({ replyToId, message }) => {
      if (!message || !message.trim()) return;
      const reply = {
        id: Date.now(),
        fromUserId: userId,
        fromUsername: username,
        replyToId: replyToId || null,
        message: message.trim().slice(0, 500),
        sentAt: Date.now()
      };
      playerReplies.unshift(reply);
      if (playerReplies.length > 500) playerReplies.pop();
      console.log(`[reply] ${username} replied to msg#${replyToId}: "${reply.message}"`);
      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:player_reply', reply);
      }
      socket.emit('player:reply_ack', { ok: true });
    });

    // Admin or host: manually set high hand for a table
    socket.on('jackpot:set_high_hand', ({ tableId: tId, description, holderName, handRank }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Admin or host required' });
      const jp = tId ? getOrCreateTableJackpot(tId, activeGames.get(tId)?.tableName) : null;
      if (!jp) return socket.emit('error', { message: 'Table not found' });
      jp.highHandDescription = description || jp.highHandDescription;
      jp.highHandUsername = holderName || jp.highHandUsername;
      if (handRank !== undefined && Number(handRank) > jp.highHandRank) jp.highHandRank = Number(handRank);
      jp.timerStart = Date.now();
      broadcastJackpotState(io);
      console.log(`[jackpot] ${username} set high hand at ${jp.tableName}: ${description} by ${holderName}`);
    });

    // Admin: get full jackpot state for all tables
    socket.on('jackpot:get_state', () => {
      socket.emit('jackpot_state', getAllJackpotState());
    });

    // Admin: activate / deactivate / hold / resume jackpot per table
    socket.on('jackpot:admin_control', ({ tableId, action }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      if (!tableId) return socket.emit('error', { message: 'tableId required' });
      const jp = tableJackpots.get(tableId);
      if (!jp) return socket.emit('error', { message: 'No jackpot for this table' });

      switch (action) {
        case 'activate':
          jp.isActive = true;
          jp.isOnHold = false;
          jp.awaitingPayout = false;
          jp.timerStart = Date.now();
          jp.pausedAt = null;
          pendingJackpotPayouts.delete(tableId);
          console.log(`[jackpot] Admin activated jackpot for ${jp.tableName}`);
          break;
        case 'deactivate':
          jp.isActive = false;
          jp.isOnHold = false;
          jp.awaitingPayout = false;
          jp.pausedAt = null;
          pendingJackpotPayouts.delete(tableId);
          console.log(`[jackpot] Admin deactivated jackpot for ${jp.tableName}`);
          break;
        case 'hold':
          if (!jp.isActive || jp.awaitingPayout) return;
          jp.isOnHold = true;
          jp.pausedAt = Date.now();
          console.log(`[jackpot] Admin put jackpot on hold for ${jp.tableName}`);
          break;
        case 'resume':
          if (jp.pausedAt) {
            jp.timerStart += (Date.now() - jp.pausedAt);
            jp.pausedAt = null;
          }
          jp.isOnHold = false;
          console.log(`[jackpot] Admin resumed jackpot for ${jp.tableName}`);
          break;
        default:
          return socket.emit('error', { message: 'Unknown jackpot action' });
      }
      broadcastJackpotState(io);
    });

    socket.on('get_table_state', ({ tableId }) => {
      const game = activeGames.get(tableId || socket.currentTableId);
      if (!game) return;
      sendPersonalizedState(io, socket, game, userId);
    });

    // ─── Tournament Events ─────────────────────────────────────────────────

    socket.on('join_tournament_room', ({ tournamentId }) => {
      socket.join(`tournament_${tournamentId}`);
      // Send current state if tournament is active
      const t = activeTournaments.get(tournamentId);
      if (t && t.status === 'active') {
        socket.emit('tournament_timer', t.getTimerState());
        socket.emit('tournament_standings', {
          tournamentId,
          standings: t.getStandings(),
          prize: t.getTotalPrize(),
          activePlayers: Array.from(t.players.values()).filter(p => !p.isEliminated).length
        });
        if (t.isOnBreak) {
          socket.emit('tournament_break_start', {
            tournamentId,
            breakRemainingMs: t.getBreakRemainingMs(),
            endsAt: t.breakEndsAt ? t.breakEndsAt.toISOString() : null
          });
        }
      }
    });

    function _wireTournamentBroadcast(tournament) {
      tournament.onBroadcast = (event, data) => {
        // Broadcast to tournament room (lobby observers + table players)
        io.to(`tournament_${tournament.id}`).emit(event, data);
        // Also broadcast to the game table room if different
        const tableId = tournament.game ? tournament.game.tableId : null;
        if (tableId && tableId !== `tournament_${tournament.id}`) {
          io.to(tableId).emit(event, data);
        }
      };
    }

    socket.on('start_tournament', async ({ tournamentId }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });

      // Load or create tournament in memory
      let tournament = activeTournaments.get(tournamentId);
      if (!tournament) {
        try {
          const { data: tData } = await supabaseAdmin
            .from('tournaments')
            .select('*, tournament_players(user_id, users(username))')
            .eq('id', tournamentId)
            .single();

          if (!tData) return socket.emit('error', { message: 'Tournament not found' });
          if (tData.status === 'completed') return socket.emit('error', { message: 'Tournament already completed' });

          tournament = new Tournament({
            id: tournamentId,
            name: tData.name,
            buyIn: tData.buy_in,
            startingChips: tData.starting_chips,
            blindSchedule: tData.blind_schedule || undefined
          });

          for (const tp of (tData.tournament_players || [])) {
            try {
              tournament.registerPlayer(tp.user_id, tp.users?.username || `Player_${tp.user_id.slice(0, 4)}`);
            } catch {}
          }

          _wireTournamentBroadcast(tournament);
          activeTournaments.set(tournamentId, tournament);
        } catch (err) {
          return socket.emit('error', { message: `Failed to load tournament: ${err.message}` });
        }
      } else {
        // Ensure broadcast is wired even if tournament was already in map
        _wireTournamentBroadcast(tournament);
      }

      try {
        // Update DB before start() fires the tournament_started broadcast so
        // lobby clients see status:'active' when they call loadTournaments()
        await supabaseAdmin
          .from('tournaments')
          .update({ status: 'active', started_at: new Date().toISOString() })
          .eq('id', tournamentId);

        tournament.start();

        // Wire tournament game into activeGames so join_table reconnect and spectate work
        const tGame = tournament.game;
        if (tGame && !activeGames.has(tGame.tableId)) {
          tGame.tableName = tournament.name;
          tGame.feltColor = '#1a5c2a';
          tGame.onBroadcast = (event, data) => io.to(tGame.tableId).emit(event, data);
          tGame.onPrivate = (uid, event, data) => {
            const sid = userSockets.get(uid);
            if (sid) io.to(sid).emit(event, data);
          };
          tGame.onHandEnd = (result) => persistHandResult(tGame.tableId, result);
          tGame.onShotClockExpired = (uid) => {
            try {
              const cp = tGame.getPlayerBySeat(tGame.currentPlayerSeat);
              if (!cp || cp.userId !== uid || !tGame.handActive) return;
              const res = tGame.processAction(uid, 'fold');
              broadcastGameState(io, tGame.tableId, tGame);
              handleActionResult(io, tGame.tableId, tGame, res);
            } catch {}
          };
          activeGames.set(tGame.tableId, tGame);
          setupGameWatchdog(io, tGame.tableId, tGame);

          // Persist result and clean up when tournament finishes
          tournament.onTournamentEnd = async ({ winner, standings }) => {
            try {
              await supabaseAdmin
                .from('tournaments')
                .update({ status: 'completed', ended_at: new Date().toISOString() })
                .eq('id', tournamentId);
              if (winner) {
                await supabaseAdmin
                  .from('tournament_players')
                  .update({ status: 'winner', placement: 1 })
                  .eq('tournament_id', tournamentId)
                  .eq('user_id', winner.userId);
              }
            } catch {}
            activeGames.delete(tGame.tableId);
            activeTournaments.delete(tournamentId);
          };
        }

        // Push initial standings
        io.to(`tournament_${tournamentId}`).emit('tournament_standings', {
          tournamentId,
          standings: tournament.getStandings(),
          prize: tournament.getTotalPrize(),
          activePlayers: tournament.players.size
        });

        // Broadcast initial game state to anyone already in the room
        if (tGame) broadcastGameState(io, tGame.tableId, tGame);

      } catch (err) {
        // Revert DB if start() failed (e.g. not enough players)
        if (tournament.status !== 'active') {
          supabaseAdmin.from('tournaments').update({ status: 'registering', started_at: null }).eq('id', tournamentId).catch(() => {});
        }
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('tournament_pause_timer', ({ tournamentId }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament) return;
      tournament.pause();
    });

    socket.on('tournament_resume_timer', ({ tournamentId }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament) return;
      tournament.resume();
    });

    socket.on('tournament_advance_level', ({ tournamentId }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament || tournament.status !== 'active') return;
      // Clear current timer before manually advancing
      if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
      if (tournament.warnTimer)  { clearTimeout(tournament.warnTimer);  tournament.warnTimer  = null; }
      tournament.advanceBlindLevel();
    });

    socket.on('tournament_call_break', ({ tournamentId, durationMinutes }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament || tournament.status !== 'active') return socket.emit('error', { message: 'Tournament not active' });
      tournament.callBreak(durationMinutes || 15);
    });

    socket.on('tournament_extend_break', ({ tournamentId, extraMinutes }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament || !tournament.isOnBreak) return socket.emit('error', { message: 'Not on break' });
      tournament.extendBreak(extraMinutes || 5);
    });

    socket.on('tournament_end_break', ({ tournamentId }) => {
      if (!isAdmin && !hostSet.has(userId)) return socket.emit('error', { message: 'Host/Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament || !tournament.isOnBreak) return;
      tournament.endBreak();
    });

    socket.on('tournament_get_standings', ({ tournamentId }) => {
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament) return;
      socket.emit('tournament_standings', {
        tournamentId,
        standings: tournament.getStandings(),
        prize: tournament.getTotalPrize(),
        activePlayers: Array.from(tournament.players.values()).filter(p => !p.isEliminated).length
      });
    });

    socket.on('get_tournament_timer', ({ tournamentId }) => {
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament || tournament.status !== 'active') return;
      socket.emit('tournament_timer', tournament.getTimerState());
    });

    // ─── Admin Events ──────────────────────────────────────────────────────

    socket.on('admin_action', async ({ action, tableId, targetUserId, amount }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });

      switch (action) {
        case 'kick': {
          const tId = tableId;
          const targetSid = userSockets.get(targetUserId);
          if (targetSid) {
            io.to(targetSid).emit('kicked', { message: 'You have been removed by admin' });
          }
          const game = activeGames.get(tId);
          if (game) {
            game.removePlayer(targetUserId);
            broadcastGameState(io, tId, game);
          }
          break;
        }
        case 'add_chips': {
          const game = activeGames.get(tableId);
          if (game) {
            const player = game.getPlayer(targetUserId);
            if (player) {
              player.chips += (amount || 0);
              broadcastGameState(io, tableId, game);
            }
          }
          break;
        }
        case 'force_fold': {
          const game = activeGames.get(tableId);
          if (game && game.handActive) {
            try {
              const result = game.processAction(targetUserId || game.getPlayerBySeat(game.currentPlayerSeat)?.userId, 'fold');
              broadcastGameState(io, tableId, game);
              handleActionResult(io, tableId, game, result);
            } catch {}
          }
          break;
        }
        case 'award_jackpot': {
          const awardTableId = tableId || data.tableId;
          // Check pending payout first (set by expiry), then live jackpot
          const pending = pendingJackpotPayouts.get(awardTableId);
          const jp = awardTableId ? tableJackpots.get(awardTableId) : null;
          if (pending) {
            const { amount: pAmt, userId: pUid, username: pName, hand: pHand, tableName: pTable } = pending;
            jp && (jp.amount = 0, jp.highHandRank = -1, jp.highHandUserId = null, jp.highHandUsername = null, jp.highHandDescription = null);
            await awardTableJackpot(io, awardTableId, pAmt, pUid, pName, pHand, pTable);
          } else if (jp && jp.amount > 0) {
            const awardAmt = jp.amount; const awardUid = jp.highHandUserId;
            const awardName = jp.highHandUsername; const awardHand = jp.highHandDescription;
            const awardTable = jp.tableName;
            jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
            jp.highHandUsername = null; jp.highHandDescription = null; jp.timerStart = Date.now();
            await awardTableJackpot(io, awardTableId, awardAmt, awardUid, awardName, awardHand, awardTable);
          }
          break;
        }
        case 'reset_jackpot': {
          const resetTableId = tableId || data.tableId;
          if (resetTableId && tableJackpots.has(resetTableId)) {
            const jp = tableJackpots.get(resetTableId);
            jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
            jp.highHandUsername = null; jp.highHandDescription = null;
            jp.timerStart = Date.now();
          } else {
            // Reset all tables
            for (const jp of tableJackpots.values()) {
              jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
              jp.highHandUsername = null; jp.highHandDescription = null;
              jp.timerStart = Date.now();
            }
          }
          broadcastJackpotState(io);
          break;
        }
        case 'close_table': {
          const game = activeGames.get(tableId);
          if (game) {
            game.destroy();
            activeGames.delete(tableId);
          }
          await supabaseAdmin.from('tables').update({ status: 'closed' }).eq('id', tableId);
          io.to(tableId).emit('table_closed', { message: 'Table closed by admin' });
          break;
        }
      }
    });

    // ─── Disconnect ────────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      socketUsers.delete(socket.id);
      userSockets.delete(userId);
      if (socket.currentTableId) {
        const tId = socket.currentTableId;
        const game = activeGames.get(tId);
        if (game) {
          const player = game.getPlayer(userId);
          if (player) player.isConnected = false;
          broadcastGameState(io, tId, game);

          // If this player held the money puck, pass it left
          const puck = tablePucks.get(tId);
          if (puck && puck.holderId === userId) {
            passMoneyPuck(io, tId, game);
          }
        }
      }
      // Clean up spectator registration
      if (socket.spectatingTableId) {
        tableSpectators.get(socket.spectatingTableId)?.delete(socket.id);
        socket.spectatingTableId = null;
      }
    });
  });
}

// ─── Game State Broadcast Helpers ──────────────────────────────────────────────

function buildTableOverview() {
  const tables = [];
  for (const [tableId, game] of activeGames) {
    const stats = tableStats.get(tableId) || {};
    const rakeData = sessionRake.byTable.get(tableId);
    tables.push({
      tableId,
      tableName: game.tableName || tableId,
      gameType: game.gameType,
      playerCount: game.players.size,
      players: Array.from(game.players.values()).map(p => ({
        username: p.username, chips: p.chips, seatNumber: p.seatNumber, hasFolded: p.hasFolded
      })),
      pot: game.pot,
      currentStreet: game.currentStreet || null,
      handActive: game.handActive,
      handNumber: game.handNumber,
      smallBlind: game.smallBlind,
      bigBlind: game.bigBlind,
      handsThisSession: stats.handsPlayed || 0,
      rakeThisSession: rakeData?.total || 0,
      spectatorCount: tableSpectators.get(tableId)?.size || 0,
      isPaused: !!game.isPaused,
      pauseReason: game.pauseReason || null
    });
  }
  return tables;
}

function _buildGodState(game) {
  const state = game.getPublicState();
  state.players = enrichPlayers(state.players.map(p => {
    const player = game.players.get(p.userId);
    return { ...p, holeCards: player?.holeCards || [] };
  }));
  state.isGodView = true;
  return state;
}

function _broadcastOverviewToAdmins(io) {
  const overview = buildTableOverview();
  for (const sid of getAdminSockets(io)) {
    io.to(sid).emit('admin:overview', overview);
  }
}

function enrichPlayers(players) {
  return players.map(p => {
    const prof = playerProfiles.get(p.userId) || {};
    return { ...p, avatarUrl: prof.avatarUrl || null, isAdmin: prof.isAdmin || false, isHost: prof.isHost || false };
  });
}

function broadcastGameState(io, tableId, game) {
  const publicState = game.getPublicState();
  publicState.players = enrichPlayers(publicState.players);
  publicState.isPaused   = !!game.isPaused;
  publicState.pauseReason = game.pauseReason || null;
  io.to(tableId).emit('game_state', publicState);

  // Send personalized state with hole cards to each player
  for (const player of game.players.values()) {
    const sid = userSockets.get(player.userId);
    if (sid) {
      const personalState = game.getPlayerState(player.userId);
      personalState.players = enrichPlayers(personalState.players);
      io.to(sid).emit('my_state', personalState);
    }
  }

  // Send god-view state to spectators
  const spectators = tableSpectators.get(tableId);
  if (spectators?.size) {
    const godState = _buildGodState(game);
    for (const sid of spectators) {
      io.to(sid).emit('spectator_state', godState);
    }
  }

  _broadcastOverviewToAdmins(io);
}

function sendPersonalizedState(io, socket, game, userId) {
  const state = game.getPlayerState(userId);
  state.players = enrichPlayers(state.players);
  socket.emit('my_state', state);
}

// ─── Hand Flow ─────────────────────────────────────────────────────────────────

async function startNewHand(io, tableId, game) {
  if (game.handActive || !game.canStartHand() || game.isPaused) return;
  // Guard against concurrent calls (e.g. two setTimeout callbacks firing close together)
  if (game._startingHand) return;
  game._startingHand = true;
  setTimeout(() => { game._startingHand = false; }, 500);

  console.log(`[hand] startNewHand ${tableId} | seated:${game.players.size} nextHand:${game.handNumber + 1}`);

  // Create hand record in DB
  let handId = null;
  try {
    const { data } = await supabaseAdmin
      .from('hands')
      .insert({ table_id: tableId, hand_number: game.handNumber + 1, status: 'active' })
      .select('id')
      .single();
    handId = data?.id;
  } catch {}

  try {
    game.startHand(handId);
  } catch (err) {
    return;
  }
  game._allInNotified    = new Set(); // reset per-hand all-in notifications
  game._lowChipsNotified = new Set(); // reset so each hand re-checks stack size

  game.lastActionAt = Date.now();
  broadcastGameState(io, tableId, game);

  // Send private hole cards
  for (const player of game.players.values()) {
    if (!player.hasFolded && player.holeCards.length > 0) {
      const sid = userSockets.get(player.userId);
      if (sid) {
        io.to(sid).emit('cards_dealt', {
          holeCards: player.holeCards,
          seatNumber: player.seatNumber
        });
      }
    }
  }

  io.to(tableId).emit('hand_started', {
    handNumber: game.handNumber,
    dealerSeat: game.dealerSeat,
    street: game.currentStreet
  });

  // Money puck: if dealer button is at puck holder, prompt straddle
  const puck = tablePucks.get(tableId);
  if (puck && puck.holderSeat === game.dealerSeat) {
    const holderSid = userSockets.get(puck.holderId);
    if (holderSid) {
      io.to(holderSid).emit('puck:straddle_required', {
        value: puck.value,
        deadline: Date.now() + 15000
      });
      puck.straddleTimeout = setTimeout(() => {
        puck.straddleTimeout = null;
        passMoneyPuck(io, tableId, game);
      }, 15000);
    }
  }

  // UTG Straddle offer (host feature, separate from money puck)
  let straddleOffered = false;
  if (game.straddleEnabled && game._utgSeat && !game._straddleOffered) {
    const utgPlayer = game.getPlayerBySeat(game._utgSeat);
    const utgSid = utgPlayer ? userSockets.get(utgPlayer.userId) : null;
    if (utgSid && !utgPlayer.isAllIn && !utgPlayer.hasFolded && utgPlayer.chips >= game.bigBlind * 2) {
      game._straddleOffered = true;
      straddleOffered = true;
      io.to(utgSid).emit('straddle_offer', { amount: game.bigBlind * 2, deadline: Date.now() + 8000 });
      game._straddleTimer = setTimeout(() => {
        game._straddleOffered = false;
        game._straddleTimer = null;
        _postStraddleAction(io, tableId, game);
      }, 8000);
    }
  }

  if (!straddleOffered) {
    io.to(tableId).emit('action_required', {
      seatNumber: game.currentPlayerSeat,
      userId: game.seats.get(game.currentPlayerSeat)
    });
  }

  // Start shot clock for first player + SMS warning after 10s
  const firstPlayer = game.getPlayerBySeat(game.currentPlayerSeat);
  if (firstPlayer && !straddleOffered) {
    game.startShotClock(firstPlayer.userId);
    const _smsUid0 = firstPlayer.userId;
    setTimeout(async () => {
      try {
        const currP = game.getPlayerBySeat(game.currentPlayerSeat);
        if (!game.handActive || !currP || currP.userId !== _smsUid0) return;
        const { data: pu } = await supabaseAdmin.from('users').select('phone, email, username').eq('id', _smsUid0).single();
        const turnText = 'Your turn at Boston Poker Club! You have 10 seconds to act.';
        if (pu?.phone) sendPlayerSMS({ phone: pu.phone, text: turnText }).catch(() => {});
        if (pu?.email) sendPlayerEmail({
          to: pu.email,
          subject: 'Your turn — Boston Poker Club',
          text: turnText,
          html: `<p>Hi <strong>${pu.username || 'there'}</strong>,</p><p>It's your turn at <strong>${game.tableName || 'the table'}</strong>. You have 10 seconds to act!</p><p>— Boston Poker Club</p>`
        }).catch(() => {});
      } catch {}
    }, 10000);
  }
}

function _getShowdownCards(game) {
  const cards = {};
  for (const player of game.players.values()) {
    if (!player.hasFolded && player.holeCards.length) {
      cards[player.userId] = player.holeCards;
    }
  }
  return cards;
}

function handleActionResult(io, tableId, game, result, _depth = 0) {
  if (!result || _depth > 6) return;

  console.log(`[result] ${tableId} hand#${game.handNumber}: ${result.action} | street:${game.currentStreet} pot:${game.pot} seat:${game.currentPlayerSeat}`);

  // All-in detection — notify admin for rebuy opportunity
  if (!game._allInNotified) game._allInNotified = new Set();
  for (const player of game.players.values()) {
    if (player.isAllIn && !game._allInNotified.has(player.userId)) {
      game._allInNotified.add(player.userId);
      pushAdminNotif(jackpotIo, {
        type: 'allin',
        title: 'Player All-In',
        body: `${player.username} went all-in with ${player.totalBetThisHand} chips at ${game.tableName || tableId}`,
        data: { userId: player.userId, username: player.username, amount: player.totalBetThisHand, tableId }
      });
      const allInMsg = `${player.username} is ALL IN ($${(player.totalBetThisHand || 0).toLocaleString()}) at ${game.tableName || tableId}. Rebuy opportunity!`;
      sendAdminPush(allInMsg, 'Player All-In').catch(() => {});
    }
  }

  // ─── All-In Runout: deal streets with pauses for drama ────────────────────
  if (result.action === 'all_in_runout') {
    broadcastGameState(io, tableId, game);
    io.to(tableId).emit('street_changed', {
      street: result.street,
      communityCards: result.communityCards,
      allInRunout: true,
      allHoleCards: _getShowdownCards(game)
    });
    setTimeout(() => {
      try {
        const nextResult = game.advanceStreet();
        game.lastActionAt = Date.now();
        broadcastGameState(io, tableId, game);
        handleActionResult(io, tableId, game, nextResult, _depth + 1);
      } catch (e) {
        console.error('[all_in_runout] advance failed:', e.message);
      }
    }, 1500);
    return;
  }

  if (result.action === 'showdown' || result.action === 'hand_ended') {
    const handResult = result.result;
    const tblName = game.tableName || tableId;
    const isSplitPot = handResult.winners.some(w => w.isSplit);

    // ── Update table session stats ────────────────────────────────────────
    const handPot = handResult.pot || 0;
    if (!tableStats.has(tableId)) {
      tableStats.set(tableId, { handsPlayed: 0, sessionStart: Date.now(), totalPot: 0, biggestPot: 0, recentTimestamps: [] });
    }
    const tStats = tableStats.get(tableId);
    tStats.handsPlayed++;
    tStats.totalPot += handPot;
    if (handPot > tStats.biggestPot) tStats.biggestPot = handPot;
    tStats.recentTimestamps.push(Date.now());
    tStats.recentTimestamps = tStats.recentTimestamps.filter(t => t > Date.now() - 7200000);
    io.to(tableId).emit('table:stats', { tableId, ...getTableStats(tableId) });

    // ── Save rabbit hunt data when hand ends by fold ──────────────────────
    if (handResult.folded && game.rabbitHuntEnabled && handResult.rabbitCards?.length > 0) {
      tableRabbitData.set(tableId, {
        cards: handResult.rabbitCards,
        foldedCards: handResult.foldedCards || {},
        communityCards: handResult.communityCards || []
      });
      io.to(tableId).emit('rabbit:available', { tableId });
    } else {
      tableRabbitData.delete(tableId);
    }

    io.to(tableId).emit('hand_ended', {
      winners: handResult.winners.map(w => ({
        userId: w.winner.userId,
        username: w.winner.username,
        amount: w.amount,
        handName: w.handResult?.name,
        holeCards: w.winner.holeCards,
        isMainPot: w.isMainPot,
        isSplit: w.isSplit || false
      })),
      communityCards: handResult.communityCards,
      rakeCollected: handResult.rakeCollected,
      pot: handResult.pot,
      folded: handResult.folded || false,
      potBreakdown: handResult.potBreakdown || null,
      allHoleCards: handResult.allHoleCards || null,
      history: handResult.history || [],
      isSplitPot
    });

    // Log each winner's profit and send SMS
    for (const w of handResult.winners) {
      if (w.winner && w.amount > 0) {
        logTransaction({
          userId: w.winner.userId,
          username: w.winner.username,
          type: 'win',
          amount: w.amount,
          tableName: tblName,
          notes: w.handResult?.name || (handResult.folded ? 'uncontested' : null)
        });
        // SMS + email: winner notification (fire-and-forget)
        (async () => {
          try {
            const { data: wu } = await supabaseAdmin.from('users').select('phone, email, username').eq('id', w.winner.userId).single();
            const winText = `Boston Poker Club: You won $${w.amount.toLocaleString()} at ${tblName}! Great hand!`;
            if (wu?.phone) sendPlayerSMS({ phone: wu.phone, text: winText }).catch(() => {});
            if (wu?.email) sendPlayerEmail({
              to: wu.email,
              subject: `You won $${w.amount.toLocaleString()} at ${tblName}! — Boston Poker Club`,
              text: winText,
              html: `<p>Hi <strong>${wu.username || 'there'}</strong>,</p><p>You won <strong>$${w.amount.toLocaleString()}</strong> at <strong>${tblName}</strong>!</p><p>Great hand! Keep it up.<br>— Boston Poker Club</p>`
            }).catch(() => {});
          } catch {}
        })();
      }
    }

    // SMS + email: low chips alert — once per session per player when stack < minimum buy-in
    if (!game._lowChipsNotified) game._lowChipsNotified = new Set();
    const lowThreshold = getMinBuyIn(game.smallBlind, game.bigBlind, game.gameType);
    for (const player of game.players.values()) {
      if (!player.isActive || game._lowChipsNotified.has(player.userId)) continue;
      if (player.chips > 0 && player.chips < lowThreshold) {
        game._lowChipsNotified.add(player.userId);
        (async () => {
          try {
            const { data: lpu } = await supabaseAdmin.from('users').select('phone, email, username').eq('id', player.userId).single();
            const lowText = 'You are running low on chips at Boston Poker Club. Contact admin to rebuy.';
            if (lpu?.phone) sendPlayerSMS({ phone: lpu.phone, text: lowText }).catch(() => {});
            if (lpu?.email) sendPlayerEmail({
              to: lpu.email,
              subject: 'Running low on chips — Boston Poker Club',
              text: lowText,
              html: `<p>Hi <strong>${lpu.username || 'there'}</strong>,</p><p>Your chip stack at <strong>${tblName}</strong> is running low ($${player.chips.toLocaleString()} remaining).</p><p>Contact admin to add chips and keep playing!<br>— Boston Poker Club</p>`
            }).catch(() => {});
          } catch {}
        })();
      }
    }

    // Schedule next hand
    setTimeout(() => startNewHand(io, tableId, game), 4000);
    return;
  }

  if (result.action === 'street_changed') {
    io.to(tableId).emit('street_changed', {
      street: result.street,
      communityCards: result.communityCards
    });
  }

  if (result.action === 'next_player' || result.action === 'street_changed') {
    const nextPlayer = game.getPlayerBySeat(game.currentPlayerSeat);
    if (nextPlayer) {
      io.to(tableId).emit('action_required', {
        seatNumber: game.currentPlayerSeat,
        userId: nextPlayer.userId,
        callAmount: Math.max(0, game.currentBet - nextPlayer.currentBet),
        minRaise: game.currentBet + game.minRaise,
        pot: game.pot
      });
      game.startShotClock(nextPlayer.userId);
      game.lastActionAt = Date.now();
      // SMS + email after 10s of inactivity on their turn
      const _smsUid = nextPlayer.userId;
      setTimeout(async () => {
        try {
          const currP = game.getPlayerBySeat(game.currentPlayerSeat);
          if (!game.handActive || !currP || currP.userId !== _smsUid) return;
          const { data: pu } = await supabaseAdmin.from('users').select('phone, email, username').eq('id', _smsUid).single();
          const turnText = 'Your turn at Boston Poker Club! You have 10 seconds to act.';
          if (pu?.phone) sendPlayerSMS({ phone: pu.phone, text: turnText }).catch(() => {});
          if (pu?.email) sendPlayerEmail({
            to: pu.email,
            subject: 'Your turn — Boston Poker Club',
            text: turnText,
            html: `<p>Hi <strong>${pu.username || 'there'}</strong>,</p><p>It's your turn at <strong>${game.tableName || 'the table'}</strong>. You have 10 seconds to act!</p><p>— Boston Poker Club</p>`
          }).catch(() => {});
        } catch {}
      }, 10000);
    } else if (game.handActive) {
      // No actionable player — all remaining are all-in; run out the board
      console.warn(`[result] no nextPlayer at seat ${game.currentPlayerSeat}, street ${game.currentStreet} — forcing board runout`);
      try {
        const advResult = game.advanceStreet();
        game.lastActionAt = Date.now();
        broadcastGameState(io, tableId, game);
        handleActionResult(io, tableId, game, advResult, _depth + 1);
      } catch (e) {
        console.error('[result] force advance failed:', e.message);
      }
    }
  }
}

// ─── Per-Table Jackpot ────────────────────────────────────────────────────────

function getOrCreateTableJackpot(tableId, tableName) {
  if (!tableJackpots.has(tableId)) {
    tableJackpots.set(tableId, {
      tableName: tableName || tableId.slice(0, 8),
      amount: 0,
      highHandRank: -1,
      highHandUserId: null,
      highHandUsername: null,
      highHandDescription: null,
      timerStart: Date.now(),
      isActive: false,
      isOnHold: false,
      awaitingPayout: false,
      pausedAt: null
    });
  }
  return tableJackpots.get(tableId);
}

function checkTableJackpot(io, tableId, handRank, userId, username, description) {
  const jp = getOrCreateTableJackpot(tableId);
  if (!jp.isActive) return;
  if (handRank > jp.highHandRank) {
    jp.highHandRank = handRank;
    jp.highHandUserId = userId;
    jp.highHandUsername = username || null;
    jp.highHandDescription = description || null;
    broadcastJackpotState(io);
    console.log(`[jackpot] New high hand at table ${jp.tableName}: rank=${handRank} by ${username}`);
  }
}

function addToTableJackpot(io, tableId, amount) {
  const jp = getOrCreateTableJackpot(tableId);
  if (!jp.isActive || jp.isOnHold || jp.awaitingPayout) return;
  jp.amount += amount;
  broadcastJackpotState(io);
}

function getAllJackpotState() {
  const now = Date.now();
  const tables = Array.from(tableJackpots.entries()).map(([tableId, jp]) => {
    let remaining;
    if (jp.awaitingPayout) {
      remaining = 0;
    } else if (jp.isOnHold && jp.pausedAt) {
      remaining = Math.max(0, JACKPOT_INTERVAL_MS - (jp.pausedAt - jp.timerStart));
    } else if (jp.isActive) {
      remaining = Math.max(0, JACKPOT_INTERVAL_MS - (now - jp.timerStart));
    } else {
      remaining = JACKPOT_INTERVAL_MS;
    }
    return {
      tableId,
      tableName: jp.tableName,
      gameType: jp.gameType || 'holdem',
      amount: jp.amount,
      highHandRank: jp.highHandRank,
      highHandUserId: jp.highHandUserId,
      highHandUsername: jp.highHandUsername,
      highHandDescription: jp.highHandDescription,
      timerStart: jp.timerStart,
      timerRemainingMs: remaining,
      timerRemainingMin: Math.ceil(remaining / 60000),
      isActive: jp.isActive || false,
      isOnHold: jp.isOnHold || false,
      awaitingPayout: jp.awaitingPayout || false
    };
  });
  const total = tables.filter(t => t.isActive).reduce((s, t) => s + t.amount, 0);
  const first = tables.find(t => t.isActive) || tables[0] || {};
  return {
    tables,
    total,
    amount: total,
    timerRemainingMs: first.timerRemainingMs ?? JACKPOT_INTERVAL_MS,
    timerRemainingMin: first.timerRemainingMin ?? 30
  };
}

function broadcastJackpotState(io) {
  io.emit('jackpot_state', getAllJackpotState());
}

function startJackpotTimer(io) {
  setInterval(async () => {
    const now = Date.now();
    for (const [tableId, jp] of tableJackpots) {
      if (!jp.isActive || jp.isOnHold || jp.awaitingPayout) continue;
      const elapsed = now - jp.timerStart;
      if (elapsed >= JACKPOT_INTERVAL_MS) {
        await expireTableJackpot(io, tableId, jp);
      }
    }
    broadcastJackpotState(io);
  }, 30000);
}

async function expireTableJackpot(io, tableId, jp) {
  const tableName = jp.tableName;
  const awarded = jp.amount;
  const winnerUserId = jp.highHandUserId;
  const winnerName = jp.highHandUsername || 'Unknown';
  const winnerHand = jp.highHandDescription || (jp.highHandRank >= 0 ? `Rank ${jp.highHandRank}` : 'No high hand');

  console.log(`[jackpot] Timer expired for table ${tableName} — $${awarded} pending, winner: ${winnerName} (${winnerHand})`);

  // Store pending payout info so admin can confirm
  if (awarded > 0) {
    pendingJackpotPayouts.set(tableId, {
      amount: awarded, userId: winnerUserId, username: winnerName, hand: winnerHand,
      tableName, expiredAt: Date.now()
    });
  }

  // Pause jackpot — DO NOT reset; awaiting admin confirmation before resetting
  jp.awaitingPayout = true;

  const summary = {
    tableId, tableName, awarded, winnerUserId, winnerName, winnerHand, pendingConfirm: true
  };

  // Notify admins via socket
  for (const sid of getAdminSockets(io)) {
    io.to(sid).emit('jackpot:expired', summary);
  }
  pushAdminNotif(io, {
    type: 'jackpot_expired',
    title: `🏆 Jackpot Expired — ${tableName}`,
    body: `High Hand: ${winnerHand} by ${winnerName} — $${awarded} to award`,
    data: summary
  });

  // Push notification to admin
  try {
    const pushText = `High Hand expired at ${tableName}. Winner: ${winnerName} — ${winnerHand}. Payout: $${awarded}. Log in to confirm.`;
    await sendAdminPush(pushText, 'High Hand Expired');
  } catch (e) {
    console.warn('[jackpot] Failed to send expiry push:', e.message);
  }
}

async function awardTableJackpot(io, tableId, amount, awardedTo, winnerName, winnerHand, tableName) {
  if (!amount) return;

  if (awardedTo) {
    try {
      await supabaseAdmin.rpc('increment_chips', { user_id: awardedTo, amount });
    } catch (_) {
      try {
        const { data } = await supabaseAdmin.from('users').select('chips').eq('id', awardedTo).single();
        if (data) await supabaseAdmin.from('users').update({ chips: data.chips + amount }).eq('id', awardedTo);
      } catch (_) {}
    }
    for (const [, s] of io.sockets.sockets) {
      if (s.user && s.user.id === awardedTo) {
        s.emit('jackpot_won', { amount, message: `You won the High Hand Jackpot: $${amount}!` });
      }
    }
  }

  // Reset jackpot and auto-start new round if still active
  const jp = tableJackpots.get(tableId);
  if (jp) {
    jp.amount = 0;
    jp.highHandRank = -1;
    jp.highHandUserId = null;
    jp.highHandUsername = null;
    jp.highHandDescription = null;
    jp.awaitingPayout = false;
    if (jp.isActive && !jp.isOnHold) {
      jp.timerStart = Date.now(); // Auto-start new 30-min round
    }
  }

  io.emit('jackpot_awarded', { amount, winnerId: awardedTo, tableId });
  broadcastJackpotState(io);
  pendingJackpotPayouts.delete(tableId);

  const tName = tableName || tableJackpots.get(tableId)?.tableName || 'Table';
  const wName = winnerName || 'Unknown';
  const wHand = winnerHand || 'High Hand';
  try {
    const { sendAdminEmail } = require('../mail');
    await sendAdminEmail({
      subject: `Jackpot Paid — ${tName}: $${amount} to ${wName}`,
      text: `High Hand Jackpot paid at ${tName}.\nWinner: ${wName} — ${wHand}\nAmount: $${amount}`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#1a7a3f">Jackpot Paid — ${tName}</h2><table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px"><tr><td style="padding:8px 14px;color:#555">Table</td><td style="padding:8px 14px;font-weight:700">${tName}</td></tr><tr style="background:#fff"><td style="padding:8px 14px;color:#555">Winner</td><td style="padding:8px 14px;font-weight:700;color:#1a7a3f">${wName}</td></tr><tr><td style="padding:8px 14px;color:#555">Hand</td><td style="padding:8px 14px">${wHand}</td></tr><tr style="background:#fff"><td style="padding:8px 14px;color:#555">Payout</td><td style="padding:8px 14px;font-weight:700;color:#c8a800">$${amount}</td></tr></table></div>`
    });
    await sendAdminPush(`Jackpot paid $${amount} to ${wName} (${wHand}) at ${tName}.`, 'Jackpot Paid');
  } catch (e) {
    console.warn('[jackpot] Award notification error:', e.message);
  }
}

// Legacy DB helpers (kept for backward compat on server restart load)
async function loadJackpotFromDB() {
  try {
    const { data } = await supabaseAdmin.from('jackpot').select('*').eq('id', 1).single();
    if (data) {
      jackpot.amount = data.current_amount || 0;
      jackpot.highHandRank = data.highest_hand_rank ?? -1;
      jackpot.highHandUserId = data.highest_hand_user_id;
      jackpot.timerStart = data.timer_started_at ? new Date(data.timer_started_at).getTime() : Date.now();
    }
  } catch {}
}

async function saveJackpotToDB() {
  try {
    const total = Array.from(tableJackpots.values()).reduce((s, jp) => s + jp.amount, 0);
    await supabaseAdmin.from('jackpot').update({
      current_amount: total,
      highest_hand_rank: jackpot.highHandRank,
      highest_hand_user_id: jackpot.highHandUserId,
      timer_started_at: new Date(jackpot.timerStart).toISOString()
    }).eq('id', 1);
  } catch {}
}

// ─── Hand Persistence ─────────────────────────────────────────────────────────

async function persistHandResult(tableId, result) {
  try {
    const winner = result.winners?.[0];
    const jackpotContrib = result.jackpotContribution || 0;
    const rakeAmount = result.rakeCollected || 0;

    // Track session rake per-table and notify admins
    if (rakeAmount > 0) {
      const game = activeGames.get(tableId);
      const tableName = game?.tableName || tableId.slice(0, 8);

      sessionRake.total += rakeAmount;
      if (!sessionRake.byTable.has(tableId)) {
        sessionRake.byTable.set(tableId, {
          tableName, total: 0, potVolume: 0, hands: [],
          hostId: game?.hostId, hostUsername: game?.hostUsername,
          hostType: game?.hostType, hostPercent: game?.hostPercent || 0
        });
      }
      const tableEntry = sessionRake.byTable.get(tableId);
      tableEntry.tableName  = tableName;
      tableEntry.total     += rakeAmount;
      tableEntry.potVolume  = (tableEntry.potVolume || 0) + (result.pot || 0);
      // Inherit host info from game if not yet set
      if (!tableEntry.hostId && game?.hostId) {
        tableEntry.hostId = game.hostId; tableEntry.hostUsername = game.hostUsername;
        tableEntry.hostType = game.hostType; tableEntry.hostPercent = game.hostPercent || 0;
      }
      const handNum = tableEntry.hands.length + 1;
      tableEntry.hands.push({ handNum, rake: rakeAmount, pot: result.pot, ts: Date.now() });
      if (tableEntry.hands.length > 200) tableEntry.hands.shift();

      if (jackpotIo) {
        const byTable = Array.from(sessionRake.byTable.entries()).map(([id, t]) => {
          const hPct = t.hostPercent || 0;
          const hAmt = Math.floor(t.total * hPct / 100);
          return {
            tableId: id, tableName: t.tableName, total: t.total, handCount: t.hands.length,
            potVolume: t.potVolume || 0,
            hostId: t.hostId, hostUsername: t.hostUsername, hostType: t.hostType, hostPercent: hPct,
            hostAmount: hAmt, houseAmount: t.total - hAmt
          };
        });
        for (const sid of getAdminSockets(jackpotIo)) {
          jackpotIo.to(sid).emit('admin:rake_update', {
            sessionTotal: sessionRake.total,
            hand: { tableId, tableName, rake: rakeAmount, pot: result.pot },
            byTable
          });
        }
      }
    }

    if (jackpotContrib > 0 && jackpotIo) {
      addToTableJackpot(jackpotIo, tableId, jackpotContrib);
    }

    await supabaseAdmin.from('hands').update({
      status: 'completed',
      pot: result.pot,
      rake_collected: result.rakeCollected,
      jackpot_contribution: jackpotContrib,
      winner_id: winner?.winner?.userId || null,
      best_hand_rank: winner?.handResult?.rank ?? null,
      community_cards: result.communityCards || [],
      ended_at: new Date().toISOString()
    }).eq('table_id', tableId).eq('status', 'active');

    // Update player_stats for everyone who played this hand
    const game = activeGames.get(tableId);
    if (game) {
      const winnerIds = new Set((result.winners || []).map(w => w.winner.userId));
      const winnerAmounts = new Map((result.winners || []).map(w => [w.winner.userId, w.amount]));
      const winnerHands = new Map((result.winners || []).map(w => [w.winner.userId, w.handResult?.name]));

      for (const player of game.players.values()) {
        const isWinner = winnerIds.has(player.userId);
        const wonAmount = winnerAmounts.get(player.userId) || 0;
        const handName = winnerHands.get(player.userId) || null;
        const lostAmount = isWinner ? 0 : (player.totalBetThisHand || 0);

        // Upsert player_stats row
        const { data: existing } = await supabaseAdmin
          .from('player_stats')
          .select('hands_played, hands_won, total_won, total_lost, biggest_pot, favorite_hand, sessions_played')
          .eq('user_id', player.userId)
          .single();

        if (existing) {
          const updates = {
            username: player.username,
            hands_played: existing.hands_played + 1,
            hands_won: existing.hands_won + (isWinner ? 1 : 0),
            total_won: existing.total_won + wonAmount,
            total_lost: existing.total_lost + lostAmount,
            biggest_pot: Math.max(existing.biggest_pot, wonAmount),
            last_hand_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          if (handName && isWinner) updates.favorite_hand = handName; // simplified: last win's hand
          await supabaseAdmin.from('player_stats').update(updates).eq('user_id', player.userId);
        } else {
          await supabaseAdmin.from('player_stats').insert({
            user_id: player.userId,
            username: player.username,
            hands_played: 1,
            hands_won: isWinner ? 1 : 0,
            total_won: wonAmount,
            total_lost: lostAmount,
            biggest_pot: wonAmount,
            favorite_hand: handName,
            sessions_played: 1,
            last_hand_at: new Date().toISOString()
          });
        }
      }
    }
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findOpenSeat(game, maxPlayers) {
  for (let i = 1; i <= maxPlayers; i++) {
    if (!game.seats.has(i)) return i;
  }
  return null;
}

async function leaveTable(socket, io, tableId, userId) {
  if (!tableId) return;
  const game = activeGames.get(tableId);
  if (game) {
    // Pass money puck before removing player so we can still find next seat
    const puck = tablePucks.get(tableId);
    if (puck && puck.holderId === userId) {
      passMoneyPuck(io, tableId, game);
    }

    const player = game.getPlayer(userId);
    if (player) {
      const chipsToReturn = player.chips;
      game.removePlayer(userId);
      broadcastGameState(io, tableId, game);

      // Return chips to player bank
      if (chipsToReturn > 0) {
        const { data: user } = await supabaseAdmin.from('users').select('chips').eq('id', userId).single();
        if (user) {
          await supabaseAdmin.from('users').update({ chips: user.chips + chipsToReturn }).eq('id', userId);
        }
      }
    }

    if (game.players.size === 0) {
      game.destroy();
      activeGames.delete(tableId);
    }
  }

  await supabaseAdmin.from('table_seats').delete().eq('table_id', tableId).eq('user_id', userId);
  socket.leave(tableId);
  socket.currentTableId = null;
  socket.emit('left_table', { tableId });

  // Notify admin of seat opening
  if (jackpotIo) {
    const leavingGame = activeGames.get(tableId);
    const tableName = leavingGame?.tableName || tableId;
    pushAdminNotif(jackpotIo, {
      type: 'seat_open',
      title: 'Seat Opened',
      body: `A seat opened at ${tableName} (${leavingGame?.players?.size ?? '?'} players remaining)`,
      data: { tableId, tableName }
    });
  }

  // Notify next person on the waiting list
  _notifyWaitlist(io, tableId);
}

function _notifyWaitlist(io, tableId) {
  const list = tableWaitlists.get(tableId);
  if (!list || list.length === 0) return;
  const next = list[0];
  const game = activeGames.get(tableId);
  const tableName = game?.tableName || tableId;
  // Socket notification
  io.to(next.socketId).emit('waitlist:seat_available', {
    tableId,
    tableName,
    message: `A seat just opened at ${tableName}! Join now before it's taken.`
  });
  // SMS
  if (next.phone) {
    sendPlayerSMS({
      phone: next.phone,
      text: `RabbsRoom: A seat opened at ${tableName}! Open the app to join now.`
    }).catch(() => {});
  }
}

function _broadcastWaitlistUpdate(io, tableId) {
  const list = (tableWaitlists.get(tableId) || []).map((e, i) => ({
    position: i + 1, userId: e.userId, username: e.username, joinedAt: e.joinedAt
  }));
  // Broadcast to admins
  for (const sid of (getAdminSockets ? getAdminSockets() : [])) {
    io.to(sid).emit('waitlist:admin_data', { tableId, list });
  }
}

function getTableStats(tableId) {
  const s = tableStats.get(tableId);
  if (!s) return { handsPlayed: 0, handsPerHour: 0, avgPot: 0, biggestPot: 0, sessionStart: null };
  const now = Date.now();
  const hoursElapsed = Math.max((now - s.sessionStart) / 3600000, 1 / 60);
  const handsPerHour = Math.round(s.handsPlayed / hoursElapsed);
  const avgPot = s.handsPlayed > 0 ? Math.round(s.totalPot / s.handsPlayed) : 0;
  return { handsPlayed: s.handsPlayed, handsPerHour, avgPot, biggestPot: s.biggestPot, sessionStart: s.sessionStart };
}

function _postStraddleAction(io, tableId, game) {
  const firstPlayer = game.getPlayerBySeat(game.currentPlayerSeat);
  if (!firstPlayer || !game.handActive) return;
  io.to(tableId).emit('action_required', {
    seatNumber: game.currentPlayerSeat,
    userId: firstPlayer.userId,
    callAmount: Math.max(0, game.currentBet - firstPlayer.currentBet),
    minRaise: game.currentBet + game.minRaise,
    pot: game.pot
  });
  game.startShotClock(firstPlayer.userId);
  game.lastActionAt = Date.now();
}

module.exports = { setupSocketHandlers, activeGames, activeTournaments, sessionRake, adminNotifs, railQueue, tableRequests, bannedUsers, broadcastMessages, pendingMessages, playerReplies, tableJackpots, pendingJackpotPayouts, awardTableJackpot, getAllJackpotState, broadcastJackpotState, getAdminSockets, tableMicMuted, tablePttMode, tableMicStatus, tableWaitlists, tableStats, getTableStats, tableSpectators, buildTableOverview };
