'use strict';

const jwt = require('jsonwebtoken');
const { PokerGame } = require('../game/poker-game');
const { Tournament } = require('../game/tournament');
const { sendTableRequestEmail, sendBroadcastEmail } = require('../mail');
const { supabaseAdmin } = require('../db/supabase');

const appEvents = require('../events');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JACKPOT_INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;
const JACKPOT_CONTRIB = parseFloat(process.env.JACKPOT_CONTRIBUTION_PERCENT) || 1;
const SHOT_CLOCK = parseInt(process.env.SHOT_CLOCK_SECONDS) || 60;

// Tiered rake: keyed by big blind thresholds
function getRakeConfig(bigBlind) {
  if (bigBlind <= 3)  return { rakePercent: 5, rakeCap: 8 };
  if (bigBlind <= 5)  return { rakePercent: 5, rakeCap: 12 };
  if (bigBlind <= 10) return { rakePercent: 5, rakeCap: 15 };
  return { rakePercent: 4, rakeCap: 20 };  // $10/$20+
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

// Host table requests: { id, hostId, hostName, gameType, sb, bb, maxPlayers, rake, requestedAt, status }
const tableRequests = [];
let tableRequestSeq = 0;

// Ban enforcement — populated from DB on startup, updated on ban/unban
const bannedUsers = new Set();

// Broadcast messages history + offline queue
const broadcastMessages = [];
let broadcastMsgSeq = 0;
const pendingMessages = new Map(); // userId -> msg[]

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
              seatNumber: existingPlayer.seatNumber,
              chips: existingPlayer.chips
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

        const { data: dbUser } = await supabaseAdmin
          .from('users')
          .select('chips, is_banned')
          .eq('id', userId)
          .single();

        // Local admin bypass only — all real players must exist in DB
        const isLocalAdmin = userId === 'local-admin-000';
        if (!dbUser && !isLocalAdmin) {
          return socket.emit('error', { message: 'Account not found. Please log out and log in again.' });
        }
        const user = dbUser || { chips: 999999, is_banned: false };

        if (user.is_banned) return socket.emit('error', { message: 'Account is banned' });
        if (!isLocalAdmin && user.chips <= 0) {
          return socket.emit('error', { message: 'You have 0 chips. Contact the admin to receive chips before joining a table.' });
        }

        const minBuyIn = getMinBuyIn(table.stakes_small_blind, table.stakes_big_blind, table.game_type);
        const chips = Math.max(buyInChips || minBuyIn, minBuyIn);

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

        // Get or create game
        let game = activeGames.get(tableId);
        if (!game) {
          const { rakePercent, rakeCap } = getRakeConfig(table.stakes_big_blind);
          game = new PokerGame({
            tableId,
            gameType: table.game_type,
            smallBlind: table.stakes_small_blind,
            bigBlind: table.stakes_big_blind,
            maxPlayers: table.max_players,
            rakePercent,
            rakeCap,
            jackpotContributionPercent: JACKPOT_CONTRIB,
            shotClockSeconds: SHOT_CLOCK
          });
          game.tableName = table.name || tableId;

          game.onBroadcast = (event, data) => io.to(tableId).emit(event, data);
          game.onPrivate = (uid, event, data) => {
            const sid = userSockets.get(uid);
            if (sid) io.to(sid).emit(event, data);
          };
          game.onHandEnd = (result) => persistHandResult(tableId, result);
          game.onJackpotCheck = (rank, uid, uname, desc) => checkTableJackpot(io, tableId, rank, uid, uname, desc);
          // Init per-table jackpot when game is created
          if (!tableJackpots.has(tableId)) {
            tableJackpots.set(tableId, {
              tableName: game.tableName,
              amount: 0,
              highHandRank: -1,
              highHandUserId: null,
              highHandUsername: null,
              highHandDescription: null,
              timerStart: Date.now()
            });
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
        }

        const finalSeat = seatNumber || findOpenSeat(game, table.max_players);
        if (!finalSeat) return socket.emit('error', { message: 'No open seats' });

        game.addPlayer(userId, username, chips, finalSeat);

        socket.join(tableId);
        socket.currentTableId = tableId;

        socket.emit('joined_table', { tableId, seatNumber: finalSeat, chips });
        broadcastGameState(io, tableId, game);
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

    socket.on('player_action', ({ tableId, action, amount }) => {
      const tId = tableId || socket.currentTableId;
      const game = activeGames.get(tId);
      if (!game) return socket.emit('error', { message: 'Game not found' });

      try {
        const result = game.processAction(userId, action, amount);
        broadcastGameState(io, tId, game);
        handleActionResult(io, tId, game, result);
      } catch (err) {
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

    socket.on('ptt:join', () => {
      const tId = socket.currentTableId;
      if (!tId) {
        console.log(`[PTT] ${username} sent ptt:join but has no currentTableId — ignoring`);
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
      console.log(`[PTT] ${username} joined as speaker on table ${tId} — ${peers.length} peer(s) in room:`, peers.map(p => p.username));
      socket.emit('ptt:peers', { peers });
      socket.to(tId).emit('ptt:speaker_active', { userId, username });
    });

    socket.on('ptt:signal', ({ targetUserId, signal }) => {
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) {
        console.log(`[PTT] signal relay: ${username} → ${targetUserId} (type=${signal.type}) via socket ${targetSid}`);
        io.to(targetSid).emit('ptt:signal', { fromUserId: userId, signal });
      } else {
        console.warn(`[PTT] signal relay FAILED: no socket found for targetUserId=${targetUserId} (type=${signal.type})`);
      }
    });

    socket.on('ptt:stop', () => {
      const tId = socket.currentTableId;
      console.log(`[PTT] ${username} stopped talking on table ${tId}`);
      if (tId) socket.to(tId).emit('ptt:speaker_stopped', { userId });
    });

    // ─── Host Actions ─────────────────────────────────────────────────────

    socket.on('host:add_chips', async ({ targetUserId, amount }) => {
      if (!hostSet.has(userId) && !isAdmin) return socket.emit('error', { message: 'Host access required' });
      if (!amount || amount <= 0) return socket.emit('error', { message: 'Amount must be positive' });

      const tId = socket.currentTableId;
      const game = tId ? activeGames.get(tId) : null;

      if (game) {
        const player = game.getPlayer(targetUserId);
        if (!player) return socket.emit('error', { message: 'Player not at this table' });
        player.chips += amount;
        broadcastGameState(io, tId, game);
      }

      // Persist to DB
      try {
        const { data } = await supabaseAdmin.from('users').select('chips').eq('id', targetUserId).single();
        if (data) await supabaseAdmin.from('users').update({ chips: data.chips + amount }).eq('id', targetUserId);
      } catch {}

      socket.emit('chips_added', { targetUserId, amount, by: username });
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('chips_received', { amount, from: username });
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

    // Admin: manually set high hand for a specific table
    socket.on('jackpot:set_high_hand', ({ tableId: tId, description, holderName, handRank }) => {
      if (!isAdmin) return;
      const jp = tId ? getOrCreateTableJackpot(tId, activeGames.get(tId)?.tableName) : null;
      if (!jp) return socket.emit('error', { message: 'Table not found' });
      jp.highHandDescription = description || jp.highHandDescription;
      jp.highHandUsername = holderName || jp.highHandUsername;
      if (handRank !== undefined && handRank > jp.highHandRank) jp.highHandRank = handRank;
      jp.timerStart = Date.now(); // reset timer on new high hand
      broadcastJackpotState(io);
      console.log(`[jackpot] Admin set high hand at ${jp.tableName}: ${description} by ${holderName}`);
    });

    // Admin: get full jackpot state for all tables
    socket.on('jackpot:get_state', () => {
      socket.emit('jackpot_state', getAllJackpotState());
    });

    socket.on('get_table_state', ({ tableId }) => {
      const game = activeGames.get(tableId || socket.currentTableId);
      if (!game) return;
      sendPersonalizedState(io, socket, game, userId);
    });

    // ─── Tournament Events ─────────────────────────────────────────────────

    socket.on('join_tournament_room', ({ tournamentId }) => {
      socket.join(`tournament_${tournamentId}`);
    });

    socket.on('start_tournament', async ({ tournamentId }) => {
      if (!isAdmin) return socket.emit('error', { message: 'Admin only' });
      const tournament = activeTournaments.get(tournamentId);
      if (!tournament) return socket.emit('error', { message: 'Tournament not found' });
      try {
        tournament.start();
        await supabaseAdmin
          .from('tournaments')
          .update({ status: 'active', started_at: new Date().toISOString() })
          .eq('id', tournamentId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
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
          // payload: { tableId, amount, userId }
          const awardTableId = tableId || data.tableId;
          const jp = awardTableId ? tableJackpots.get(awardTableId) : null;
          if (jp) {
            const awardAmt = jp.amount;
            const awardUid = jp.highHandUserId;
            jp.amount = 0; jp.highHandRank = -1; jp.highHandUserId = null;
            jp.highHandUsername = null; jp.highHandDescription = null;
            jp.timerStart = Date.now();
            if (awardUid) await awardTableJackpot(io, awardTableId, awardAmt, awardUid);
            broadcastJackpotState(io);
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
    });
  });
}

// ─── Game State Broadcast Helpers ──────────────────────────────────────────────

function broadcastGameState(io, tableId, game) {
  const publicState = game.getPublicState();
  io.to(tableId).emit('game_state', publicState);

  // Send personalized state with hole cards to each player
  for (const player of game.players.values()) {
    const sid = userSockets.get(player.userId);
    if (sid) {
      const personalState = game.getPlayerState(player.userId);
      io.to(sid).emit('my_state', personalState);
    }
  }
}

function sendPersonalizedState(io, socket, game, userId) {
  const state = game.getPlayerState(userId);
  socket.emit('my_state', state);
}

// ─── Hand Flow ─────────────────────────────────────────────────────────────────

async function startNewHand(io, tableId, game) {
  if (game.handActive || !game.canStartHand()) return;
  // Guard against concurrent calls (e.g. two setTimeout callbacks firing close together)
  if (game._startingHand) return;
  game._startingHand = true;
  setTimeout(() => { game._startingHand = false; }, 500);

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
  game._allInNotified = new Set(); // reset per-hand all-in notifications

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

  io.to(tableId).emit('action_required', {
    seatNumber: game.currentPlayerSeat,
    userId: game.seats.get(game.currentPlayerSeat)
  });

  // Start shot clock for first player
  const firstPlayer = game.getPlayerBySeat(game.currentPlayerSeat);
  if (firstPlayer) game.startShotClock(firstPlayer.userId);
}

function handleActionResult(io, tableId, game, result) {
  if (!result) return;

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
    }
  }

  if (result.action === 'showdown' || result.action === 'hand_ended') {
    const handResult = result.result;
    io.to(tableId).emit('hand_ended', {
      winners: handResult.winners.map(w => ({
        userId: w.winner.userId,
        username: w.winner.username,
        amount: w.amount,
        handName: w.handResult?.name,
        holeCards: w.winner.holeCards,
        isMainPot: w.isMainPot
      })),
      communityCards: handResult.communityCards,
      rakeCollected: handResult.rakeCollected,
      pot: handResult.pot,
      folded: handResult.folded || false
    });

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
      timerStart: Date.now()
    });
  }
  return tableJackpots.get(tableId);
}

function checkTableJackpot(io, tableId, handRank, userId, username, description) {
  const jp = getOrCreateTableJackpot(tableId);
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
  jp.amount += amount;
  broadcastJackpotState(io);
}

function getAllJackpotState() {
  const now = Date.now();
  const tables = Array.from(tableJackpots.entries()).map(([tableId, jp]) => {
    const remaining = Math.max(0, JACKPOT_INTERVAL_MS - (now - jp.timerStart));
    return {
      tableId,
      tableName: jp.tableName,
      amount: jp.amount,
      highHandRank: jp.highHandRank,
      highHandUserId: jp.highHandUserId,
      highHandUsername: jp.highHandUsername,
      highHandDescription: jp.highHandDescription,
      timerStart: jp.timerStart,
      timerRemainingMs: remaining,
      timerRemainingMin: Math.ceil(remaining / 60000)
    };
  });
  const total = tables.reduce((s, t) => s + t.amount, 0);
  // Backward-compat fields (use total / first table for old clients)
  const first = tables[0] || {};
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
      const elapsed = now - jp.timerStart;
      if (elapsed >= JACKPOT_INTERVAL_MS) {
        await expireTableJackpot(io, tableId, jp);
      }
    }
    broadcastJackpotState(io);
  }, 30000); // check every 30s
}

async function expireTableJackpot(io, tableId, jp) {
  const tableName = jp.tableName;
  const awarded = jp.amount;
  const winner = jp.highHandUserId;
  const winnerName = jp.highHandUsername || 'Unknown';
  const winnerHand = jp.highHandDescription || `Rank ${jp.highHandRank}`;

  console.log(`[jackpot] Timer expired for table ${tableName} — $${awarded} to ${winnerName} (${winnerHand})`);

  // Notify admin via socket
  const summary = {
    tableId, tableName, awarded, winner, winnerName, winnerHand,
    pendingConfirm: true
  };
  for (const sid of getAdminSockets(io)) {
    io.to(sid).emit('jackpot:expired', summary);
  }

  // Push admin notification
  pushAdminNotif(io, {
    type: 'jackpot_expired',
    title: `🏆 Jackpot Expired — ${tableName}`,
    body: `High Hand: ${winnerHand} by ${winnerName} — $${awarded} to award`,
    data: summary
  });

  // Send email to admin
  try {
    const { sendAdminEmail } = require('../mail');
    await sendAdminEmail({
      subject: `🏆 High Hand Jackpot Expired — ${tableName}`,
      text: `High Hand Jackpot expired at ${tableName}. Winner: ${winnerName} (${winnerHand}) — $${awarded} to award. Log in to admin panel to confirm payout.`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#c8a800">🏆 High Hand Jackpot — ${tableName}</h2>
          <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px">
            <tr><td style="padding:8px 14px;color:#555;width:140px">Table</td><td style="padding:8px 14px;font-weight:700">${tableName}</td></tr>
            <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Winner</td><td style="padding:8px 14px;font-weight:700;color:#1a7a3f">${winnerName}</td></tr>
            <tr><td style="padding:8px 14px;color:#555">Hand</td><td style="padding:8px 14px">${winnerHand}</td></tr>
            <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Payout</td><td style="padding:8px 14px;font-weight:700;font-size:1.2rem;color:#c8a800">$${awarded}</td></tr>
          </table>
          <p style="margin-top:20px;color:#666">Log in to the <a href="https://rabbsroom.com/admin.html" style="color:#1a7a3f">admin panel</a> to confirm payout.</p>
        </div>`
    });
  } catch (e) {
    console.warn('[jackpot] Failed to send expiry email:', e.message);
  }

  // Reset this table's jackpot (admin still confirms payout manually)
  jp.amount = 0;
  jp.highHandRank = -1;
  jp.highHandUserId = null;
  jp.highHandUsername = null;
  jp.highHandDescription = null;
  jp.timerStart = Date.now();
}

async function awardTableJackpot(io, tableId, amount, awardedTo) {
  if (!awardedTo || !amount) return;
  try {
    await supabaseAdmin.rpc('increment_chips', { user_id: awardedTo, amount });
  } catch (_) {
    try {
      const { data } = await supabaseAdmin.from('users').select('chips').eq('id', awardedTo).single();
      if (data) await supabaseAdmin.from('users').update({ chips: data.chips + amount }).eq('id', awardedTo);
    } catch (_) {}
  }
  // Notify winner
  for (const [, s] of io.sockets.sockets) {
    if (s.user && s.user.id === awardedTo) {
      s.emit('jackpot_won', { amount, message: `🏆 You won the High Hand Jackpot: $${amount}!` });
    }
  }
  io.emit('jackpot_awarded', { amount, winnerId: awardedTo, tableId });
  broadcastJackpotState(io);
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
        sessionRake.byTable.set(tableId, { tableName, total: 0, hands: [] });
      }
      const tableEntry = sessionRake.byTable.get(tableId);
      tableEntry.tableName = tableName;
      tableEntry.total += rakeAmount;
      tableEntry.hands.push({ rake: rakeAmount, pot: result.pot, ts: Date.now() });
      if (tableEntry.hands.length > 100) tableEntry.hands.shift();

      if (jackpotIo) {
        const byTable = Array.from(sessionRake.byTable.entries()).map(([id, t]) => ({
          tableId: id, tableName: t.tableName, total: t.total, handCount: t.hands.length
        }));
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
}

module.exports = { setupSocketHandlers, activeGames, activeTournaments, sessionRake, adminNotifs, railQueue, tableRequests, bannedUsers, broadcastMessages, tableJackpots, getAdminSockets };
