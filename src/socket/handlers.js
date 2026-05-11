'use strict';

const jwt = require('jsonwebtoken');
const { PokerGame } = require('../game/poker-game');
const { Tournament } = require('../game/tournament');
const { supabaseAdmin } = require('../db/supabase');

const appEvents = require('../events');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JACKPOT_INTERVAL_MS = (parseInt(process.env.JACKPOT_INTERVAL_MINUTES) || 30) * 60 * 1000;
const JACKPOT_CONTRIB = parseFloat(process.env.JACKPOT_CONTRIBUTION_PERCENT) || 1;
const SHOT_CLOCK = parseInt(process.env.SHOT_CLOCK_SECONDS) || 20;

// Tiered rake: keyed by big blind thresholds
function getRakeConfig(bigBlind) {
  if (bigBlind <= 3)  return { rakePercent: 5, rakeCap: 8 };
  if (bigBlind <= 5)  return { rakePercent: 5, rakeCap: 12 };
  if (bigBlind <= 10) return { rakePercent: 5, rakeCap: 15 };
  return { rakePercent: 4, rakeCap: 20 };  // $10/$20+
}

// In-memory state
const activeGames = new Map();       // tableId -> PokerGame
const activeTournaments = new Map(); // tournamentId -> Tournament
const socketUsers = new Map();       // socketId -> { userId, username, isAdmin }
const userSockets = new Map();       // userId -> socketId

// Jackpot state
let jackpot = { amount: 0, highHandRank: -1, highHandUserId: null, timerStart: Date.now() };
let jackpotIo = null;

// Session rake tracking (resets on server restart)
// byTable: Map<tableId, { tableName, total, hands[] }>
const sessionRake = { total: 0, byTable: new Map() };

function getAdminSockets(io) {
  const sids = [];
  for (const [sid, info] of socketUsers) {
    if (info.isAdmin) sids.push(sid);
  }
  return sids;
}

function setupSocketHandlers(io) {
  jackpotIo = io;
  loadJackpotFromDB();
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

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id: userId, username, isAdmin } = socket.user;
    socketUsers.set(socket.id, { userId, username, isAdmin });
    userSockets.set(userId, socket.id);

    socket.emit('jackpot_state', getJackpotPublicState());

    // ─── Table Events ──────────────────────────────────────────────────────

    socket.on('join_table', async ({ tableId, seatNumber, buyInChips }) => {
      try {
        const { data: dbTable } = await supabaseAdmin
          .from('tables')
          .select('*')
          .eq('id', tableId)
          .single();

        // Fall back to config from existing in-memory game if Supabase unavailable
        const existingGame = activeGames.get(tableId);
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

        const chips = buyInChips || table.stakes_big_blind * 20;
        if (user.chips < chips) return socket.emit('error', { message: 'Insufficient chips' });

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
          game.onJackpotCheck = (rank, uid) => checkJackpot(io, rank, uid);
          game.onShotClockExpired = (uid) => {
            try {
              const result = game.processAction(uid, 'fold');
              broadcastGameState(io, tableId, game);
              handleActionResult(io, tableId, game, result);
            } catch {}
          };

          activeGames.set(tableId, game);
        }

        // Remove player if already seated (reconnect)
        if (game.getPlayer(userId)) game.removePlayer(userId);

        const finalSeat = seatNumber || findOpenSeat(game, table.max_players);
        if (!finalSeat) return socket.emit('error', { message: 'No open seats' });

        game.addPlayer(userId, username, chips, finalSeat);

        socket.join(tableId);
        socket.currentTableId = tableId;

        socket.emit('joined_table', { tableId, seatNumber: finalSeat, chips });
        broadcastGameState(io, tableId, game);

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
      if (!tId) return;
      // Collect peer list for the speaker (everyone else in the room)
      const sids = io.sockets.adapter.rooms.get(tId) || new Set();
      const peers = [];
      for (const sid of sids) {
        const peer = socketUsers.get(sid);
        if (peer && peer.userId !== userId) {
          peers.push({ userId: peer.userId, username: peer.username });
        }
      }
      socket.emit('ptt:peers', { peers });
      socket.to(tId).emit('ptt:speaker_active', { userId, username });
    });

    socket.on('ptt:signal', ({ targetUserId, signal }) => {
      const targetSid = userSockets.get(targetUserId);
      if (targetSid) io.to(targetSid).emit('ptt:signal', { fromUserId: userId, signal });
    });

    socket.on('ptt:stop', () => {
      const tId = socket.currentTableId;
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

    socket.on('lobby:join', () => {
      // Player is in the lobby — notify admins
      for (const sid of getAdminSockets(io)) {
        io.to(sid).emit('admin:player_in_lobby', { userId, username });
      }
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
          await awardJackpot(io);
          break;
        }
        case 'reset_jackpot': {
          jackpot = { amount: 0, highHandRank: -1, highHandUserId: null, timerStart: Date.now() };
          await saveJackpotToDB();
          io.emit('jackpot_state', getJackpotPublicState());
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
        const game = activeGames.get(socket.currentTableId);
        if (game) {
          const player = game.getPlayer(userId);
          if (player) player.isConnected = false;
          broadcastGameState(io, socket.currentTableId, game);
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

// ─── Jackpot ──────────────────────────────────────────────────────────────────

function checkJackpot(io, handRank, userId) {
  if (handRank > jackpot.highHandRank) {
    jackpot.highHandRank = handRank;
    jackpot.highHandUserId = userId;
    saveJackpotToDB();
    io.emit('jackpot_state', getJackpotPublicState());
  }
}

function addToJackpot(io, amount) {
  jackpot.amount += amount;
  io.emit('jackpot_state', getJackpotPublicState());
}

function getJackpotPublicState() {
  const elapsed = Date.now() - jackpot.timerStart;
  const remaining = Math.max(0, JACKPOT_INTERVAL_MS - elapsed);
  return {
    amount: jackpot.amount,
    highHandRank: jackpot.highHandRank,
    highHandUserId: jackpot.highHandUserId,
    timerRemainingMs: remaining,
    timerRemainingMin: Math.ceil(remaining / 60000)
  };
}

function startJackpotTimer(io) {
  setInterval(async () => {
    const elapsed = Date.now() - jackpot.timerStart;
    if (elapsed >= JACKPOT_INTERVAL_MS && jackpot.amount > 0) {
      await awardJackpot(io);
    } else {
      io.emit('jackpot_state', getJackpotPublicState());
    }
  }, 60000);
}

async function awardJackpot(io) {
  if (jackpot.amount === 0) return;

  const awarded = jackpot.amount;
  const awardedTo = jackpot.highHandUserId;

  if (awardedTo) {
    try {
      await supabaseAdmin.rpc('increment_chips', { user_id: awardedTo, amount: awarded });
    } catch (_) {
      try {
        const { data } = await supabaseAdmin.from('users').select('chips').eq('id', awardedTo).single();
        if (data) await supabaseAdmin.from('users').update({ chips: data.chips + awarded }).eq('id', awardedTo);
      } catch (_) {}
    }

    const sid = userSockets.get(awardedTo);
    if (sid && io) {
      io.to(sid).emit('jackpot_won', { amount: awarded, message: `You won the High Hand Jackpot: $${awarded}!` });
    }
  }

  jackpot = { amount: 0, highHandRank: -1, highHandUserId: null, timerStart: Date.now() };
  await saveJackpotToDB();

  if (io) {
    io.emit('jackpot_awarded', { amount: awarded, winnerId: awardedTo });
    io.emit('jackpot_state', getJackpotPublicState());
  }
}

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
    await supabaseAdmin.from('jackpot').update({
      current_amount: jackpot.amount,
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
      addToJackpot(jackpotIo, jackpotContrib);
      await saveJackpotToDB();
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
}

module.exports = { setupSocketHandlers, activeGames, activeTournaments, sessionRake };
