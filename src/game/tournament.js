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

    this.players = new Map(); // userId -> { userId, username, chips, placement, isEliminated }
    this.currentBlindLevel = 0;
    this.game = null;
    this.blindTimer = null;
    this.warnTimer = null;        // 30-second warning before next level
    this.startedAt = null;
    this.endedAt = null;

    // Timer tracking
    this.levelStartedAt = null;   // Date when current level began
    this.levelDurationMs = 0;     // Total ms for current level
    this.isPaused = false;
    this.pausedRemainingMs = null; // ms remaining when paused

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

    this.game = new PokerGame({
      tableId: tableConfig.tableId || `tournament_${this.id}`,
      gameType: tableConfig.gameType || 'holdem',
      smallBlind: currentBlinds.small_blind,
      bigBlind: currentBlinds.big_blind,
      maxPlayers: Math.min(this.players.size, 9),
      rakePercent: 0,
      ...tableConfig
    });

    let seatNumber = 1;
    for (const [userId, player] of this.players) {
      this.game.addPlayer(userId, player.username, player.chips, seatNumber++);
    }

    this._startBlindTimer();

    if (this.onBroadcast) {
      this.onBroadcast('tournament_started', {
        tournamentId: this.id,
        blindLevel: this.currentBlindLevel + 1,
        smallBlind: currentBlinds.small_blind,
        bigBlind: currentBlinds.big_blind,
        players: this.getStandings(),
        timerState: this.getTimerState()
      });
    }

    return this.game;
  }

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

    // Pause blind timer and record remaining ms
    if (!this.isPaused) {
      if (this.blindTimer) clearTimeout(this.blindTimer);
      if (this.warnTimer)  clearTimeout(this.warnTimer);
      this.isPaused = true;
      this.pausedRemainingMs = this._getRemainingMs();
    }

    // Clear any existing break timers
    if (this.breakTimer)     clearTimeout(this.breakTimer);
    if (this.breakWarnTimer) clearTimeout(this.breakWarnTimer);

    const breakMs = durationMinutes * 60 * 1000;
    this.isOnBreak  = true;
    this.breakEndsAt = new Date(Date.now() + breakMs);

    // 2-minute warning before break ends
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

    // Auto-end break
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

    // Resume the blind timer
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

    if (nextLevel >= this.blindSchedule.length) {
      const lastLevel   = this.blindSchedule[this.blindSchedule.length - 1];
      const multiplier  = 2 ** (nextLevel - this.blindSchedule.length + 1);
      this.currentBlindLevel = nextLevel;

      const newBlinds = {
        level: nextLevel + 1,
        small_blind: lastLevel.small_blind * multiplier,
        big_blind:   lastLevel.big_blind   * multiplier,
        duration_minutes: lastLevel.duration_minutes
      };

      if (this.game) {
        this.game.smallBlind = newBlinds.small_blind;
        this.game.bigBlind   = newBlinds.big_blind;
      }

      this._startBlindTimer();
      if (this.onBroadcast) {
        this.onBroadcast('blind_increase', {
          tournamentId: this.id,
          blindLevel: nextLevel + 1,
          ...newBlinds,
          timerState: this.getTimerState()
        });
      }
      return;
    }

    this.currentBlindLevel = nextLevel;
    const newLevel = this.blindSchedule[nextLevel];

    if (this.game) {
      this.game.smallBlind = newLevel.small_blind;
      this.game.bigBlind   = newLevel.big_blind;
    }

    this._startBlindTimer();

    if (this.onBroadcast) {
      this.onBroadcast('blind_increase', {
        tournamentId: this.id,
        blindLevel: nextLevel + 1,
        small_blind: newLevel.small_blind,
        big_blind:   newLevel.big_blind,
        duration_minutes: newLevel.duration_minutes,
        timerState: this.getTimerState()
      });
    }

    if (this.onBlindIncrease) this.onBlindIncrease(newLevel);
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
      schedule:        this.blindSchedule
    };
  }

  // ─── Player Elimination & Standings ───────────────────────────────────────

  eliminatePlayer(userId) {
    const player = this.players.get(userId);
    if (!player) return;

    const remainingPlayers = Array.from(this.players.values()).filter(p => !p.isEliminated);
    player.isEliminated = true;
    player.placement = remainingPlayers.length;

    if (this.game) this.game.removePlayer(userId);

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
      // Broadcast updated standings
      this.onBroadcast('tournament_standings', {
        tournamentId: this.id,
        standings: this.getStandings(),
        prize: this.getTotalPrize(),
        activePlayers: Array.from(this.players.values()).filter(p => !p.isEliminated).length
      });
    }

    this.checkFinished();
  }

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
      timerState: this.status === 'active' ? this.getTimerState() : null
    };
  }

  destroy() {
    if (this.blindTimer)     { clearTimeout(this.blindTimer);     this.blindTimer = null; }
    if (this.warnTimer)      { clearTimeout(this.warnTimer);      this.warnTimer  = null; }
    if (this.breakTimer)     { clearTimeout(this.breakTimer);     this.breakTimer = null; }
    if (this.breakWarnTimer) { clearTimeout(this.breakWarnTimer); this.breakWarnTimer = null; }
    if (this.game) this.game.destroy();
  }
}

module.exports = { Tournament };
