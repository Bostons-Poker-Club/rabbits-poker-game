'use strict';

const { PokerGame } = require('./poker-game');

class Tournament {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.buyIn = config.buyIn || 100;
    this.startingChips = config.startingChips || 10000;
    this.status = 'registering'; // registering | active | completed
    this.blindSchedule = config.blindSchedule || [
      { level: 1, small_blind: 25,  big_blind: 50,   duration_minutes: 15 },
      { level: 2, small_blind: 50,  big_blind: 100,  duration_minutes: 15 },
      { level: 3, small_blind: 75,  big_blind: 150,  duration_minutes: 15 },
      { level: 4, small_blind: 100, big_blind: 200,  duration_minutes: 15 },
      { level: 5, small_blind: 150, big_blind: 300,  duration_minutes: 15 },
      { level: 6, small_blind: 200, big_blind: 400,  duration_minutes: 15 },
      { level: 7, small_blind: 300, big_blind: 600,  duration_minutes: 15 },
      { level: 8, small_blind: 500, big_blind: 1000, duration_minutes: 15 }
    ];

    this.players = new Map();      // userId -> { userId, username, chips, placement, isEliminated }
    this.tables = new Map();       // tableId -> PokerGame  (all active tables)
    this.playerTables = new Map(); // userId -> tableId     (which table each active player is at)

    // Backward compat: points to the only/final table, null for multi-table while >1 table exists
    this.game = null;

    this.maxPlayersPerTable = config.maxPlayersPerTable || 9;
    this.minPlayersToConsolidate = 4; // move players off a table when it drops below this

    this.currentBlindLevel = 0;
    this.blindTimer = null;
    this.warnTimer = null;
    this.startedAt = null;
    this.endedAt = null;

    // Timer tracking
    this.levelStartedAt = null;
    this.levelDurationMs = 0;
    this.isPaused = false;
    this.pausedRemainingMs = null;

    // Break state
    this.isOnBreak = false;
    this.breakEndsAt = null;
    this.breakTimer = null;
    this.breakWarnTimer = null;

    // Callbacks
    this.onBroadcast = null;
    this.onPlayerEliminated = null;
    this.onTournamentEnd = null;
    this.onBlindIncrease = null;
  }

  registerPlayer(userId, username) {
    if (this.status !== 'registering') {
      throw new Error('Tournament registration is closed');
    }
    if (this.players.has(userId)) {
      throw new Error('Already registered');
    }

    this.players.set(userId, {
      userId,
      username,
      chips: this.startingChips,
      placement: null,
      isEliminated: false
    });

    return { playersRegistered: this.players.size };
  }

  unregisterPlayer(userId) {
    if (this.status !== 'registering') {
      throw new Error('Cannot unregister after tournament starts');
    }
    this.players.delete(userId);
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  start(tableConfig = {}) {
    if (this.status !== 'registering') {
      throw new Error('Tournament already started');
    }
    if (this.players.size < 2) {
      throw new Error('Need at least 2 players');
    }

    this.status = 'active';
    this.startedAt = new Date();
    this.currentBlindLevel = 0;

    const currentBlinds = this.blindSchedule[0];
    const perTable = this.maxPlayersPerTable;

    // Shuffle players for random seating
    const playerArray = Array.from(this.players.values());
    for (let i = playerArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerArray[i], playerArray[j]] = [playerArray[j], playerArray[i]];
    }

    const numTables = Math.max(1, Math.ceil(playerArray.length / perTable));

    for (let t = 0; t < numTables; t++) {
      // Single table uses the legacy ID; multi-table adds a numeric suffix
      const tableId = numTables === 1
        ? `tournament_${this.id}`
        : `tournament_${this.id}_${t + 1}`;

      // Distribute players evenly: table 0 gets indices 0, numTables, 2*numTables, …
      const tablePlayers = playerArray.filter((_, i) => i % numTables === t);

      const game = new PokerGame({
        tableId,
        gameType: tableConfig.gameType || 'holdem',
        smallBlind: currentBlinds.small_blind,
        bigBlind: currentBlinds.big_blind,
        maxPlayers: perTable,
        rakePercent: 0,
      });

      tablePlayers.forEach((p, i) => {
        game.addPlayer(p.userId, p.username, p.chips, i + 1);
        this.playerTables.set(p.userId, tableId);
      });

      this.tables.set(tableId, game);
    }

    // Backward compat: this.game is the single/final table
    if (this.tables.size === 1) {
      this.game = this.tables.values().next().value;
    }

    this._startBlindTimer();

    if (this.onBroadcast) {
      // Build per-player table assignments so lobby/table clients can redirect
      const tableAssignments = {};
      for (const [uid, tid] of this.playerTables) {
        tableAssignments[uid] = tid;
      }
      this.onBroadcast('tournament_started', {
        tournamentId: this.id,
        blindLevel: this.currentBlindLevel + 1,
        smallBlind: currentBlinds.small_blind,
        bigBlind: currentBlinds.big_blind,
        players: this.getStandings(),
        timerState: this.getTimerState(),
        tables: Array.from(this.tables.keys()),
        tableAssignments,
      });
    }

    return this.tables;
  }

  // ─── Table Lookup ─────────────────────────────────────────────────────────

  getTableForPlayer(userId) {
    return this.playerTables.get(userId) || null;
  }

  // ─── Blind Timer ──────────────────────────────────────────────────────────

  _startBlindTimer(remainingMs = null) {
    if (this.blindTimer) clearTimeout(this.blindTimer);
    if (this.warnTimer)  clearTimeout(this.warnTimer);

    const currentLevel = this._currentLevelConfig();
    if (!currentLevel) return;

    const durationMs = remainingMs !== null
      ? remainingMs
      : currentLevel.duration_minutes * 60 * 1000;

    this.levelDurationMs  = currentLevel.duration_minutes * 60 * 1000;
    this.levelStartedAt   = new Date(Date.now() - (this.levelDurationMs - durationMs));
    this.isPaused         = false;
    this.pausedRemainingMs = null;

    // 30-second warning before next level
    const warnAt = durationMs - 30_000;
    if (warnAt > 0) {
      this.warnTimer = setTimeout(() => {
        if (this.onBroadcast) {
          const next = this._nextLevelConfig();
          this.onBroadcast('blind_warning', {
            tournamentId: this.id,
            nextLevel: this.currentBlindLevel + 2,
            nextSmallBlind: next.small_blind,
            nextBigBlind:   next.big_blind,
            secondsUntil:   30
          });
        }
      }, warnAt);
    }

    this.blindTimer = setTimeout(() => {
      this.advanceBlindLevel();
    }, durationMs);
  }

  pause() {
    if (this.status !== 'active' || this.isPaused) return;
    if (this.blindTimer) clearTimeout(this.blindTimer);
    if (this.warnTimer)  clearTimeout(this.warnTimer);
    this.isPaused = true;
    this.pausedRemainingMs = this._getRemainingMs();
    if (this.onBroadcast) {
      this.onBroadcast('tournament_timer_paused', { timerState: this.getTimerState() });
    }
  }

  resume() {
    if (!this.isPaused) return;
    const remaining = this.pausedRemainingMs || 0;
    this._startBlindTimer(remaining);
    if (this.onBroadcast) {
      this.onBroadcast('tournament_timer_resumed', { timerState: this.getTimerState() });
    }
  }

  // ─── Break System ─────────────────────────────────────────────────────────

  callBreak(durationMinutes = 15) {
    if (this.status !== 'active') return;

    if (!this.isPaused) {
      if (this.blindTimer) clearTimeout(this.blindTimer);
      if (this.warnTimer)  clearTimeout(this.warnTimer);
      this.isPaused = true;
      this.pausedRemainingMs = this._getRemainingMs();
    }

    if (this.breakTimer)     clearTimeout(this.breakTimer);
    if (this.breakWarnTimer) clearTimeout(this.breakWarnTimer);

    const breakMs = durationMinutes * 60 * 1000;
    this.isOnBreak  = true;
    this.breakEndsAt = new Date(Date.now() + breakMs);

    const warnMs = breakMs - 2 * 60 * 1000;
    if (warnMs > 0) {
      this.breakWarnTimer = setTimeout(() => {
        if (this.onBroadcast) {
          this.onBroadcast('tournament_break_warning', {
            tournamentId: this.id,
            secondsRemaining: 120
          });
        }
      }, warnMs);
    }

    this.breakTimer = setTimeout(() => this.endBreak(), breakMs);

    if (this.onBroadcast) {
      this.onBroadcast('tournament_break_start', {
        tournamentId: this.id,
        durationMinutes,
        breakRemainingMs: breakMs,
        endsAt: this.breakEndsAt.toISOString()
      });
    }
  }

  extendBreak(extraMinutes = 5) {
    if (!this.isOnBreak || !this.breakEndsAt) return;

    if (this.breakTimer)     clearTimeout(this.breakTimer);
    if (this.breakWarnTimer) clearTimeout(this.breakWarnTimer);

    const extraMs = extraMinutes * 60 * 1000;
    this.breakEndsAt = new Date(this.breakEndsAt.getTime() + extraMs);
    const remainingMs = Math.max(0, this.breakEndsAt.getTime() - Date.now());

    const warnMs = remainingMs - 2 * 60 * 1000;
    if (warnMs > 0) {
      this.breakWarnTimer = setTimeout(() => {
        if (this.onBroadcast) {
          this.onBroadcast('tournament_break_warning', {
            tournamentId: this.id,
            secondsRemaining: 120
          });
        }
      }, warnMs);
    }

    this.breakTimer = setTimeout(() => this.endBreak(), remainingMs);

    if (this.onBroadcast) {
      this.onBroadcast('tournament_break_extended', {
        tournamentId: this.id,
        extraMinutes,
        breakRemainingMs: remainingMs,
        endsAt: this.breakEndsAt.toISOString()
      });
    }
  }

  endBreak() {
    if (!this.isOnBreak) return;

    if (this.breakTimer)     { clearTimeout(this.breakTimer);     this.breakTimer = null; }
    if (this.breakWarnTimer) { clearTimeout(this.breakWarnTimer); this.breakWarnTimer = null; }

    this.isOnBreak  = false;
    this.breakEndsAt = null;

    this.resume();

    if (this.onBroadcast) {
      this.onBroadcast('tournament_break_end', {
        tournamentId: this.id,
        timerState: this.getTimerState()
      });
    }
  }

  getBreakRemainingMs() {
    if (!this.isOnBreak || !this.breakEndsAt) return 0;
    return Math.max(0, this.breakEndsAt.getTime() - Date.now());
  }

  // ─── Blind Level Advancement ───────────────────────────────────────────────

  advanceBlindLevel() {
    const nextLevel = this.currentBlindLevel + 1;

    let newBlinds;
    if (nextLevel >= this.blindSchedule.length) {
      const lastLevel  = this.blindSchedule[this.blindSchedule.length - 1];
      const multiplier = 2 ** (nextLevel - this.blindSchedule.length + 1);
      this.currentBlindLevel = nextLevel;
      newBlinds = {
        level: nextLevel + 1,
        small_blind: lastLevel.small_blind * multiplier,
        big_blind:   lastLevel.big_blind   * multiplier,
        duration_minutes: lastLevel.duration_minutes
      };
    } else {
      this.currentBlindLevel = nextLevel;
      newBlinds = this.blindSchedule[nextLevel];
    }

    // Apply new blinds to ALL active tables
    for (const game of this.tables.values()) {
      game.smallBlind = newBlinds.small_blind;
      game.bigBlind   = newBlinds.big_blind;
    }

    this._startBlindTimer();

    if (this.onBroadcast) {
      this.onBroadcast('blind_increase', {
        tournamentId: this.id,
        blindLevel: nextLevel + 1,
        small_blind: newBlinds.small_blind,
        big_blind:   newBlinds.big_blind,
        duration_minutes: newBlinds.duration_minutes,
        timerState: this.getTimerState()
      });
    }

    if (this.onBlindIncrease) this.onBlindIncrease(newBlinds);
  }

  _currentLevelConfig() {
    const idx = Math.min(this.currentBlindLevel, this.blindSchedule.length - 1);
    const base = this.blindSchedule[idx] || this.blindSchedule[this.blindSchedule.length - 1];
    if (this.currentBlindLevel < this.blindSchedule.length) return base;
    const mult = 2 ** (this.currentBlindLevel - this.blindSchedule.length + 1);
    return {
      ...base,
      level: this.currentBlindLevel + 1,
      small_blind: base.small_blind * mult,
      big_blind:   base.big_blind   * mult
    };
  }

  _nextLevelConfig() {
    const next = this.currentBlindLevel + 1;
    if (next < this.blindSchedule.length) return this.blindSchedule[next];
    const last = this.blindSchedule[this.blindSchedule.length - 1];
    const mult = 2 ** (next - this.blindSchedule.length + 1);
    return { ...last, level: next + 1, small_blind: last.small_blind * mult, big_blind: last.big_blind * mult };
  }

  _getRemainingMs() {
    if (this.isPaused) return this.pausedRemainingMs || 0;
    if (!this.levelStartedAt) return 0;
    const elapsed = Date.now() - this.levelStartedAt.getTime();
    return Math.max(0, this.levelDurationMs - elapsed);
  }

  getTimerState() {
    const level    = this._currentLevelConfig();
    const next     = this._nextLevelConfig();
    const remaining = this._getRemainingMs();
    return {
      tournamentId:    this.id,
      tournamentName:  this.name,
      isPaused:        this.isPaused,
      isOnBreak:       this.isOnBreak,
      breakRemainingMs: this.getBreakRemainingMs(),
      breakEndsAt:     this.breakEndsAt ? this.breakEndsAt.toISOString() : null,
      currentLevel:    this.currentBlindLevel + 1,
      smallBlind:      level.small_blind,
      bigBlind:        level.big_blind,
      remainingMs:     remaining,
      levelDurationMs: this.levelDurationMs,
      nextLevel:       this.currentBlindLevel + 2,
      nextSmallBlind:  next.small_blind,
      nextBigBlind:    next.big_blind,
      schedule:        this.blindSchedule,
      activeTables:    this.tables.size
    };
  }

  // ─── Player Elimination ────────────────────────────────────────────────────

  eliminatePlayer(userId) {
    const player = this.players.get(userId);
    if (!player || player.isEliminated) return { moves: [], closedTables: [] };

    const remainingActive = Array.from(this.players.values()).filter(p => !p.isEliminated);
    player.isEliminated = true;
    player.placement = remainingActive.length;

    // Remove from their specific table
    const tableId = this.playerTables.get(userId);
    if (tableId) {
      const game = this.tables.get(tableId);
      if (game) game.removePlayer(userId);
      this.playerTables.delete(userId);
    } else if (this.game) {
      this.game.removePlayer(userId);
    }

    if (this.onPlayerEliminated) {
      this.onPlayerEliminated({ userId, username: player.username, placement: player.placement });
    }

    if (this.onBroadcast) {
      this.onBroadcast('player_eliminated', {
        tournamentId: this.id,
        userId,
        username: player.username,
        placement: player.placement
      });
      this.onBroadcast('tournament_standings', {
        tournamentId: this.id,
        standings: this.getStandings(),
        prize: this.getTotalPrize(),
        activePlayers: Array.from(this.players.values()).filter(p => !p.isEliminated).length
      });
    }

    const consolidation = this.consolidateIfNeeded();

    this.checkFinished();

    return consolidation;
  }

  // ─── Table Consolidation ──────────────────────────────────────────────────

  consolidateIfNeeded() {
    const moves = [];
    const closedTables = [];

    if (this.tables.size <= 1) return { moves, closedTables };

    const getOccupancy = (tableId) => {
      let count = 0;
      for (const [uid, tid] of this.playerTables) {
        if (tid !== tableId) continue;
        const p = this.players.get(uid);
        if (p && !p.isEliminated) count++;
      }
      return count;
    };

    // Repeatedly find and consolidate under-full tables until none remain
    let changed = true;
    while (changed && this.tables.size > 1) {
      changed = false;
      for (const [tableId] of this.tables) {
        const occ = getOccupancy(tableId);
        if (occ === 0) {
          // Empty table — just close it
          const oldGame = this.tables.get(tableId);
          if (oldGame) oldGame.destroy();
          this.tables.delete(tableId);
          closedTables.push(tableId);
          if (this.tables.size === 1) {
            this.game = this.tables.values().next().value;
            if (this.onBroadcast) {
              this.onBroadcast('tournament_final_table', {
                tournamentId: this.id,
                tableId: this.game.tableId
              });
            }
          }
          changed = true;
          break;
        }

        if (occ < this.minPlayersToConsolidate && this.tables.size > 1) {
          // Gather active players at this table
          const sourcePlayers = [];
          for (const [uid, tid] of this.playerTables) {
            if (tid !== tableId) continue;
            const p = this.players.get(uid);
            if (p && !p.isEliminated) sourcePlayers.push(uid);
          }

          // Find target tables with available seats, fewest players first
          const targets = [];
          for (const [tid] of this.tables) {
            if (tid === tableId) continue;
            const cnt = getOccupancy(tid);
            if (cnt < this.maxPlayersPerTable) targets.push({ tableId: tid, count: cnt });
          }
          targets.sort((a, b) => a.count - b.count);

          if (!targets.length) continue;

          const batchMoves = [];
          for (let i = 0; i < sourcePlayers.length; i++) {
            const uid = sourcePlayers[i];
            const target = targets[i % targets.length];
            this._movePlayerToTable(uid, tableId, target.tableId);
            target.count++;
            const p = this.players.get(uid);
            batchMoves.push({ userId: uid, username: p?.username, fromTableId: tableId, toTableId: target.tableId });
          }
          moves.push(...batchMoves);

          const oldGame = this.tables.get(tableId);
          if (oldGame) oldGame.destroy();
          this.tables.delete(tableId);
          closedTables.push(tableId);

          if (this.onBroadcast) {
            this.onBroadcast('tournament_table_closed', {
              tournamentId: this.id,
              tableId,
              moves: batchMoves
            });
          }

          if (this.tables.size === 1) {
            this.game = this.tables.values().next().value;
            if (this.onBroadcast) {
              this.onBroadcast('tournament_final_table', {
                tournamentId: this.id,
                tableId: this.game.tableId
              });
            }
          }

          changed = true;
          break;
        }
      }
    }

    return { moves, closedTables };
  }

  _movePlayerToTable(userId, fromTableId, toTableId) {
    const player = this.players.get(userId);
    if (!player) return;

    // Sync chips from the game being left
    const fromGame = this.tables.get(fromTableId);
    if (fromGame) {
      const gp = fromGame.getPlayer(userId);
      if (gp) player.chips = gp.chips;
      fromGame.removePlayer(userId);
    }

    // Add to the new game
    const toGame = this.tables.get(toTableId);
    if (toGame) {
      const seat = this._findOpenSeat(toGame);
      if (seat) {
        try {
          toGame.addPlayer(userId, player.username, player.chips, seat);
        } catch (e) {
          console.warn('[tournament] _movePlayerToTable failed:', e.message);
        }
      }
    }

    this.playerTables.set(userId, toTableId);
  }

  _findOpenSeat(game) {
    const taken = new Set(Array.from(game.players.values()).map(p => p.seatNumber));
    for (let s = 1; s <= (game.maxPlayers || 9); s++) {
      if (!taken.has(s)) return s;
    }
    return null;
  }

  // ─── End Condition ────────────────────────────────────────────────────────

  checkFinished() {
    const activePlayers = Array.from(this.players.values()).filter(p => !p.isEliminated);

    if (activePlayers.length <= 1) {
      const winner = activePlayers[0];
      if (winner) winner.placement = 1;

      this.status = 'completed';
      this.endedAt = new Date();

      if (this.blindTimer) { clearTimeout(this.blindTimer); this.blindTimer = null; }
      if (this.warnTimer)  { clearTimeout(this.warnTimer);  this.warnTimer  = null; }
      if (this.breakTimer) { clearTimeout(this.breakTimer); this.breakTimer = null; }
      if (this.breakWarnTimer) { clearTimeout(this.breakWarnTimer); this.breakWarnTimer = null; }

      if (this.onTournamentEnd) {
        this.onTournamentEnd({ winner, standings: this.getStandings(), prize: this.getTotalPrize() });
      }

      if (this.onBroadcast) {
        this.onBroadcast('tournament_ended', {
          tournamentId: this.id,
          winner,
          standings: this.getStandings(),
          prize: this.getTotalPrize()
        });
      }
    }
  }

  // ─── Standings / State ────────────────────────────────────────────────────

  getTotalPrize() {
    return this.players.size * this.buyIn;
  }

  getStandings() {
    return Array.from(this.players.values())
      .sort((a, b) => {
        if (a.isEliminated && !b.isEliminated) return 1;
        if (!a.isEliminated && b.isEliminated) return -1;
        if (a.placement && b.placement) return a.placement - b.placement;
        return b.chips - a.chips;
      })
      .map((p, idx) => ({ ...p, rank: p.placement || idx + 1 }));
  }

  getCurrentBlinds() {
    const level = this._currentLevelConfig();
    return {
      level: this.currentBlindLevel + 1,
      smallBlind: level.small_blind,
      bigBlind:   level.big_blind
    };
  }

  getState() {
    return {
      id: this.id,
      name: this.name,
      buyIn: this.buyIn,
      startingChips: this.startingChips,
      status: this.status,
      currentBlinds: this.getCurrentBlinds(),
      players: this.getStandings(),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      timerState: this.status === 'active' ? this.getTimerState() : null,
      tables: Array.from(this.tables.keys()),
    };
  }

  destroy() {
    if (this.blindTimer)     { clearTimeout(this.blindTimer);     this.blindTimer = null; }
    if (this.warnTimer)      { clearTimeout(this.warnTimer);      this.warnTimer  = null; }
    if (this.breakTimer)     { clearTimeout(this.breakTimer);     this.breakTimer = null; }
    if (this.breakWarnTimer) { clearTimeout(this.breakWarnTimer); this.breakWarnTimer = null; }
    for (const game of this.tables.values()) game.destroy();
    this.tables.clear();
  }
}

module.exports = { Tournament };
