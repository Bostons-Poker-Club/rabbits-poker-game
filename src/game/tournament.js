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
      { level: 1, small_blind: 25, big_blind: 50, duration_minutes: 15 },
      { level: 2, small_blind: 50, big_blind: 100, duration_minutes: 15 },
      { level: 3, small_blind: 75, big_blind: 150, duration_minutes: 15 },
      { level: 4, small_blind: 100, big_blind: 200, duration_minutes: 15 },
      { level: 5, small_blind: 150, big_blind: 300, duration_minutes: 15 },
      { level: 6, small_blind: 200, big_blind: 400, duration_minutes: 15 },
      { level: 7, small_blind: 300, big_blind: 600, duration_minutes: 15 },
      { level: 8, small_blind: 500, big_blind: 1000, duration_minutes: 15 }
    ];

    this.players = new Map(); // userId -> { userId, username, chips, placement, isEliminated }
    this.currentBlindLevel = 0;
    this.game = null;
    this.blindTimer = null;
    this.startedAt = null;
    this.endedAt = null;

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

    // Create a poker game for this tournament
    this.game = new PokerGame({
      tableId: tableConfig.tableId || `tournament_${this.id}`,
      gameType: tableConfig.gameType || 'holdem',
      smallBlind: currentBlinds.small_blind,
      bigBlind: currentBlinds.big_blind,
      maxPlayers: Math.min(this.players.size, 9),
      rakePercent: 0, // No rake in tournaments
      ...tableConfig
    });

    // Add all players to game
    let seatNumber = 1;
    for (const [userId, player] of this.players) {
      this.game.addPlayer(userId, player.username, player.chips, seatNumber++);
    }

    // Start blind timer
    this._startBlindTimer();

    if (this.onBroadcast) {
      this.onBroadcast('tournament_started', {
        tournamentId: this.id,
        blindLevel: this.currentBlindLevel + 1,
        smallBlind: currentBlinds.small_blind,
        bigBlind: currentBlinds.big_blind,
        players: this.getStandings()
      });
    }

    return this.game;
  }

  _startBlindTimer() {
    if (this.blindTimer) clearInterval(this.blindTimer);

    const currentLevel = this.blindSchedule[this.currentBlindLevel];
    if (!currentLevel) return;

    const durationMs = currentLevel.duration_minutes * 60 * 1000;

    this.blindTimer = setTimeout(() => {
      this.advanceBlindLevel();
    }, durationMs);
  }

  advanceBlindLevel() {
    const nextLevel = this.currentBlindLevel + 1;

    if (nextLevel >= this.blindSchedule.length) {
      // Use last level blinds (keep increasing)
      const lastLevel = this.blindSchedule[this.blindSchedule.length - 1];
      const multiplier = 2 ** (nextLevel - this.blindSchedule.length + 1);
      this.currentBlindLevel = nextLevel;

      const newBlinds = {
        level: nextLevel + 1,
        small_blind: lastLevel.small_blind * multiplier,
        big_blind: lastLevel.big_blind * multiplier,
        duration_minutes: lastLevel.duration_minutes
      };

      if (this.game) {
        this.game.smallBlind = newBlinds.small_blind;
        this.game.bigBlind = newBlinds.big_blind;
      }

      if (this.onBroadcast) {
        this.onBroadcast('blind_increase', { blindLevel: nextLevel + 1, ...newBlinds });
      }

      this._startBlindTimer();
      return;
    }

    this.currentBlindLevel = nextLevel;
    const newLevel = this.blindSchedule[nextLevel];

    if (this.game) {
      this.game.smallBlind = newLevel.small_blind;
      this.game.bigBlind = newLevel.big_blind;
    }

    if (this.onBroadcast) {
      this.onBroadcast('blind_increase', {
        blindLevel: nextLevel + 1,
        small_blind: newLevel.small_blind,
        big_blind: newLevel.big_blind,
        duration_minutes: newLevel.duration_minutes
      });
    }

    if (this.onBlindIncrease) {
      this.onBlindIncrease(newLevel);
    }

    this._startBlindTimer();
  }

  eliminatePlayer(userId) {
    const player = this.players.get(userId);
    if (!player) return;

    const remainingPlayers = Array.from(this.players.values()).filter(p => !p.isEliminated);
    player.isEliminated = true;
    player.placement = remainingPlayers.length;

    if (this.game) {
      this.game.removePlayer(userId);
    }

    if (this.onPlayerEliminated) {
      this.onPlayerEliminated({ userId, username: player.username, placement: player.placement });
    }

    if (this.onBroadcast) {
      this.onBroadcast('player_eliminated', {
        userId,
        username: player.username,
        placement: player.placement
      });
    }

    this.checkFinished();
  }

  checkFinished() {
    const activePlayers = Array.from(this.players.values()).filter(p => !p.isEliminated);

    if (activePlayers.length <= 1) {
      const winner = activePlayers[0];
      if (winner) {
        winner.placement = 1;
      }

      this.status = 'completed';
      this.endedAt = new Date();

      if (this.blindTimer) {
        clearTimeout(this.blindTimer);
        this.blindTimer = null;
      }

      if (this.onTournamentEnd) {
        this.onTournamentEnd({
          winner,
          standings: this.getStandings(),
          prize: this.getTotalPrize()
        });
      }

      if (this.onBroadcast) {
        this.onBroadcast('tournament_ended', {
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
      .map((p, idx) => ({
        ...p,
        rank: p.placement || idx + 1
      }));
  }

  getCurrentBlinds() {
    const level = this.blindSchedule[Math.min(this.currentBlindLevel, this.blindSchedule.length - 1)];
    return {
      level: this.currentBlindLevel + 1,
      smallBlind: level ? level.small_blind : 25,
      bigBlind: level ? level.big_blind : 50
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
      endedAt: this.endedAt
    };
  }

  destroy() {
    if (this.blindTimer) {
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
    }
    if (this.game) {
      this.game.destroy();
    }
  }
}

module.exports = { Tournament };
