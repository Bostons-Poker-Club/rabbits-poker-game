'use strict';

const { Deck } = require('./deck');
const { evaluateBestHand, evaluatePLOHand, compareHandResults, HAND_NAMES } = require('./hand-evaluator');

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_COMMUNITY_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };

class PokerGame {
  constructor(tableConfig) {
    this.tableId = tableConfig.tableId;
    this.gameType = tableConfig.gameType || 'holdem'; // 'holdem' or 'plo'
    this.smallBlind = tableConfig.smallBlind || 5;
    this.bigBlind = tableConfig.bigBlind || 10;
    this.maxPlayers = tableConfig.maxPlayers || 9;
    this.rakePercent = tableConfig.rakePercent || 10;
    this.rakeCap = tableConfig.rakeCap || 15;

    // Player map: seatNumber -> player object
    this.players = new Map(); // userId -> player
    this.seats = new Map();   // seatNumber -> userId

    // Game state
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentStreet = null;
    this.dealerSeat = null;
    this.currentPlayerSeat = null;
    this.handNumber = 0;
    this.handActive = false;
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastAggressorSeat = null;

    // Shot clock
    this.shotClockTimer = null;
    this.shotClockWarningTimer = null;
    this.shotClockDuration = tableConfig.shotClockSeconds || 40;

    // Callbacks
    this.onBroadcast = null;      // fn(event, data) - broadcast to all at table
    this.onPrivate = null;        // fn(userId, event, data) - send to one player
    this.onHandEnd = null;        // fn(handResult) - persist to DB
    this.onShotClockExpired = null; // fn(userId) - auto-fold player
    this.onJackpotCheck = null;   // fn(handRank, userId)

    // Jackpot
    this.jackpotFlatContrib = tableConfig.jackpotFlatContrib || 1; // flat $1 per hand

    // Hand tracking
    this.currentHandId = null;
    this.rakeCollected = 0;
    this.jackpotContribution = 0;

    // Hand history (actions taken this hand)
    this.handHistory = [];

    // Players who acted this street (for tracking betting complete)
    this.playersActedThisStreet = new Set();

    // All-in tracking
    this.allInPlayers = new Set();

    // Watchdog / stuck-game detection
    this.lastActionAt = Date.now();

    // Straddle option
    this.straddleEnabled = tableConfig.straddleEnabled || false;
    this.straddlePlayerSeat = null;
    this._utgSeat = null;
    this._straddleOffered = false;
    this._straddleTimer = null;

    // Rabbit hunt
    this.rabbitHuntEnabled = tableConfig.rabbitHuntEnabled || false;
  }

  // ─── Player Management ─────────────────────────────────────────────────

  addPlayer(userId, username, chips, seatNumber) {
    if (this.players.has(userId)) {
      throw new Error('Player already at table');
    }
    if (this.seats.has(seatNumber)) {
      throw new Error('Seat already taken');
    }
    if (seatNumber < 1 || seatNumber > this.maxPlayers) {
      throw new Error('Invalid seat number');
    }

    const player = {
      userId,
      username,
      chips,
      seatNumber,
      holeCards: [],
      currentBet: 0,
      totalBetThisHand: 0,
      hasFolded: false,
      isAllIn: false,
      isSittingOut: false,
      breakPassesUsed: 0,
      breakStartHandNumber: null, // hand# when they went on break (for missed-blind detection)
      joinedMidHand: false,       // joined while a hand was active; auto-cleared at next hand start
      mustPostBlind: false,       // returned from break and must post BB before playing
      pendingBlindPost: 0,        // BB amount staged to post at next hand start
      isConnected: true
    };

    this.players.set(userId, player);
    this.seats.set(seatNumber, userId);
    return player;
  }

  removePlayer(userId) {
    const player = this.players.get(userId);
    if (!player) return;
    this.seats.delete(player.seatNumber);
    this.players.delete(userId);
  }

  movePlayer(userId, newSeatNumber) {
    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (this.seats.has(newSeatNumber)) throw new Error('Seat already taken');
    if (newSeatNumber < 1 || newSeatNumber > this.maxPlayers) throw new Error('Invalid seat number');
    this.seats.delete(player.seatNumber);
    player.seatNumber = newSeatNumber;
    this.seats.set(newSeatNumber, userId);
  }

  getPlayer(userId) {
    return this.players.get(userId);
  }

  getPlayerBySeat(seatNumber) {
    const userId = this.seats.get(seatNumber);
    return userId ? this.players.get(userId) : null;
  }

  getActivePlayers() {
    return Array.from(this.players.values()).filter(p => !p.isSittingOut && p.isConnected);
  }

  getHandPlayers() {
    // Players still in the hand. Disconnected players are NOT excluded —
    // they stay in until the shot clock auto-folds them, preventing a
    // false "everyone folded" when someone briefly loses connection.
    return Array.from(this.players.values()).filter(p => !p.hasFolded && !p.isSittingOut);
  }

  getSortedSeats() {
    return Array.from(this.seats.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([seat, userId]) => ({ seat, userId, player: this.players.get(userId) }));
  }

  // ─── Hand Start ─────────────────────────────────────────────────────────

  canStartHand() {
    // Count players who are active OR who joined mid-hand and will be auto-unseated
    // at the start of the next hand (so 2-player games with a mid-hand joiner still start).
    const count = Array.from(this.players.values()).filter(
      p => (!p.isSittingOut || p.joinedMidHand) && p.isConnected
    ).length;
    return count >= 2;
  }

  startHand(handId = null) {
    // Auto-unsit players who joined while the previous hand was active.
    // They sat out that hand and are ready to play now.
    for (const player of this.players.values()) {
      if (player.joinedMidHand) {
        player.joinedMidHand = false;
        player.isSittingOut = false;
      }
    }

    if (!this.canStartHand()) {
      throw new Error('Not enough players to start hand');
    }

    this.currentHandId = handId;
    this.handNumber++;
    this.handActive = true;
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.rakeCollected = 0;
    this.jackpotContribution = 0;
    this.handHistory = [];
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressorSeat = null;
    this.playersActedThisStreet = new Set();
    this.allInPlayers = new Set();

    // Reset player hand state
    for (const player of this.players.values()) {
      player.holeCards = [];
      player.currentBet = 0;
      player.totalBetThisHand = 0;
      player.hasFolded = player.isSittingOut;
      player.isAllIn = false;
    }

    // Advance dealer
    this._advanceDealer();

    // Deal hole cards
    this.deck.reset();
    this.deck.shuffle();

    const active = this._getHandOrderPlayers();
    const holeCardCount = this.gameType === 'plo' ? 4 : 2;
    for (const player of active) {
      player.holeCards = this.deck.deal(holeCardCount);
    }

    // Post blinds
    this._postBlinds(active);

    this.currentStreet = 'preflop';
    this.straddlePlayerSeat = null;
    this._straddleOffered = false;
    this.lastActionAt = Date.now();

    console.log(`[poker] hand#${this.handNumber} | type:${this.gameType} blinds:${this.smallBlind}/${this.bigBlind} players:${active.length} dealer:${this.dealerSeat} firstAct:${this.currentPlayerSeat}`);

    return {
      handNumber: this.handNumber,
      dealerSeat: this.dealerSeat,
      players: active.map(p => ({ userId: p.userId, seatNumber: p.seatNumber }))
    };
  }

  _advanceDealer() {
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 0) return;

    const sortedSeats = activePlayers.map(p => p.seatNumber).sort((a, b) => a - b);

    if (this.dealerSeat === null) {
      this.dealerSeat = sortedSeats[0];
    } else {
      const currentIndex = sortedSeats.indexOf(this.dealerSeat);
      if (currentIndex === -1 || currentIndex === sortedSeats.length - 1) {
        this.dealerSeat = sortedSeats[0];
      } else {
        this.dealerSeat = sortedSeats[currentIndex + 1];
      }
    }
  }

  _getHandOrderPlayers() {
    // Returns players in order starting from dealer+1
    const active = this.getActivePlayers().sort((a, b) => a.seatNumber - b.seatNumber);
    const dealerIndex = active.findIndex(p => p.seatNumber === this.dealerSeat);
    if (dealerIndex === -1) return active;
    return [...active.slice(dealerIndex + 1), ...active.slice(0, dealerIndex + 1)];
  }

  _postBlinds(orderedPlayers) {
    if (orderedPlayers.length < 2) return;

    let sbPlayer, bbPlayer;

    if (orderedPlayers.length === 2) {
      // Heads up: dealer posts SB
      sbPlayer = orderedPlayers[orderedPlayers.length - 1]; // dealer
      bbPlayer = orderedPlayers[0];
    } else {
      sbPlayer = orderedPlayers[0];
      bbPlayer = orderedPlayers[1];
    }

    // Post small blind
    const sbAmount = Math.min(this.smallBlind, sbPlayer.chips);
    sbPlayer.chips -= sbAmount;
    sbPlayer.currentBet = sbAmount;
    sbPlayer.totalBetThisHand += sbAmount;
    this.pot += sbAmount;
    if (sbPlayer.chips === 0) {
      sbPlayer.isAllIn = true;
      this.allInPlayers.add(sbPlayer.userId);
    }
    this.handHistory.push({ street: 'preflop', userId: sbPlayer.userId, username: sbPlayer.username, action: 'post_sb', amount: sbAmount });

    // Post big blind
    const bbAmount = Math.min(this.bigBlind, bbPlayer.chips);
    bbPlayer.chips -= bbAmount;
    bbPlayer.currentBet = bbAmount;
    bbPlayer.totalBetThisHand += bbAmount;
    this.pot += bbAmount;
    if (bbPlayer.chips === 0) {
      bbPlayer.isAllIn = true;
      this.allInPlayers.add(bbPlayer.userId);
    }
    this.handHistory.push({ street: 'preflop', userId: bbPlayer.userId, username: bbPlayer.username, action: 'post_bb', amount: bbAmount });

    this.currentBet = bbAmount;
    this.minRaise = bbAmount;

    // Handle returning-from-break players who staged a blind post.
    // If they're naturally in SB/BB this hand, their regular blind satisfies the
    // requirement — just clear the pending amount. Otherwise post as dead money.
    for (const player of orderedPlayers) {
      if (!player.pendingBlindPost) continue;
      if (player === sbPlayer || player === bbPlayer) {
        player.pendingBlindPost = 0; // natural blind already covers it
      } else {
        const amount = Math.min(player.pendingBlindPost, player.chips);
        player.chips -= amount;
        player.totalBetThisHand += amount;
        this.pot += amount;
        this.handHistory.push({
          street: 'preflop',
          userId: player.userId,
          username: player.username,
          action: 'post_blind',
          amount
        });
        player.pendingBlindPost = 0;
      }
    }

    // First to act preflop is after BB
    const bbIndex = orderedPlayers.indexOf(bbPlayer);
    const firstToActIndex = (bbIndex + 1) % orderedPlayers.length;
    this.currentPlayerSeat = orderedPlayers[firstToActIndex].seatNumber;
    this.lastAggressorSeat = bbPlayer.seatNumber;

    // Record UTG for optional straddle (3+ players only)
    this._utgSeat = orderedPlayers.length >= 3 ? orderedPlayers[firstToActIndex].seatNumber : null;

    // Do NOT mark SB/BB as acted — they must voluntarily act.
    // BB gets the "option" to raise even if everyone just calls.
  }

  acceptStraddle(userId) {
    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (player.seatNumber !== this._utgSeat) throw new Error('Not UTG player');
    if (player.isAllIn || player.hasFolded) throw new Error('Player cannot straddle');

    const straddleAmount = this.bigBlind * 2;
    const actual = Math.min(straddleAmount, player.chips);
    player.chips -= actual;
    player.currentBet += actual;
    player.totalBetThisHand += actual;
    this.pot += actual;

    if (player.chips === 0) {
      player.isAllIn = true;
      this.allInPlayers.add(player.userId);
    }

    this.currentBet = player.currentBet;
    this.minRaise = this.bigBlind * 2;
    this.straddlePlayerSeat = player.seatNumber;
    this.lastAggressorSeat = player.seatNumber;

    // Reset acted set — everyone must act relative to the straddle
    this.playersActedThisStreet = new Set();

    // UTG+1 acts first
    const handPlayers = this._getHandOrderPlayers();
    const utgIdx = handPlayers.findIndex(p => p.seatNumber === this._utgSeat);
    const nextIdx = (utgIdx + 1) % handPlayers.length;
    this.currentPlayerSeat = handPlayers[nextIdx].seatNumber;

    this.handHistory.push({ street: 'preflop', userId: player.userId, username: player.username, action: 'straddle', amount: actual });
    return { straddleAmount: actual, straddlePlayerSeat: this.straddlePlayerSeat };
  }

  // ─── Action Processing ──────────────────────────────────────────────────

  processAction(userId, action, amount = 0) {
    if (!this.handActive) {
      throw new Error('No active hand');
    }

    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (player.seatNumber !== this.currentPlayerSeat) {
      throw new Error('Not your turn');
    }
    if (player.hasFolded || player.isAllIn) {
      throw new Error('Player cannot act');
    }

    this.clearShotClock();
    this.lastActionAt = Date.now();

    switch (action) {
      case 'fold':
        this._processFold(player);
        break;
      case 'check':
        this._processCheck(player);
        break;
      case 'call':
        this._processCall(player);
        break;
      case 'bet':
      case 'raise':
        this._processRaise(player, amount, action);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    this.playersActedThisStreet.add(userId);

    // Check if hand is over (everyone folded)
    const activePlayers = this.getHandPlayers().filter(p => !p.isAllIn);
    const allActive = this.getHandPlayers();

    if (allActive.length === 1 && !allActive[0].isAllIn) {
      // Everyone else folded - current player wins
      return this._awardPotToLastPlayer();
    }

    // Check if all remaining players are all-in
    const nonAllIn = allActive.filter(p => !p.isAllIn);
    if (nonAllIn.length <= 1 && this._bettingComplete()) {
      return this.advanceStreet();
    }

    // Check if betting round is complete
    if (this._bettingComplete()) {
      return this.advanceStreet();
    }

    // Move to next player
    this._advanceCurrentPlayer();
    return { action: 'next_player', currentPlayerSeat: this.currentPlayerSeat };
  }

  _processFold(player) {
    player.hasFolded = true;
    this.handHistory.push({ street: this.currentStreet, userId: player.userId, username: player.username, action: 'fold' });
  }

  _processCheck(player) {
    if (player.currentBet < this.currentBet) {
      throw new Error('Cannot check, must call or raise');
    }
    this.handHistory.push({ street: this.currentStreet, userId: player.userId, username: player.username, action: 'check' });
  }

  _processCall(player) {
    const callAmount = Math.min(this.currentBet - player.currentBet, player.chips);
    player.chips -= callAmount;
    player.currentBet += callAmount;
    player.totalBetThisHand += callAmount;
    this.pot += callAmount;

    if (player.chips === 0) {
      player.isAllIn = true;
      this.allInPlayers.add(player.userId);
    }
    this.handHistory.push({ street: this.currentStreet, userId: player.userId, username: player.username, action: player.isAllIn ? 'all_in' : 'call', amount: callAmount });
  }

  _processRaise(player, totalAmount, actionLabel = 'raise') {
    // totalAmount is the total bet amount (not the raise increment)
    const callAmount = this.currentBet - player.currentBet;

    if (totalAmount <= this.currentBet) {
      throw new Error(`Raise must be more than current bet of ${this.currentBet}`);
    }

    // For PLO: enforce pot-limit
    if (this.gameType === 'plo') {
      const maxPotLimit = this.pot + callAmount + (this.pot + callAmount);
      if (totalAmount > maxPotLimit && player.chips > maxPotLimit - player.currentBet) {
        throw new Error(`PLO: max raise is ${maxPotLimit}`);
      }
    }

    const raiseIncrement = totalAmount - this.currentBet;
    if (raiseIncrement < this.minRaise && totalAmount < player.chips + player.currentBet) {
      throw new Error(`Min raise increment is ${this.minRaise}`);
    }

    const actualBet = Math.min(totalAmount - player.currentBet, player.chips);
    player.chips -= actualBet;
    player.currentBet += actualBet;
    player.totalBetThisHand += actualBet;
    this.pot += actualBet;

    const newTotalBet = player.currentBet;
    if (newTotalBet > this.currentBet) {
      this.minRaise = newTotalBet - this.currentBet;
      this.currentBet = newTotalBet;
      this.lastAggressorSeat = player.seatNumber;
      // Reset who has acted (they need to act again after raise)
      this.playersActedThisStreet = new Set([player.userId]);
    }

    if (player.chips === 0) {
      player.isAllIn = true;
      this.allInPlayers.add(player.userId);
    }
    this.handHistory.push({ street: this.currentStreet, userId: player.userId, username: player.username, action: player.isAllIn ? 'all_in' : actionLabel, amount: player.currentBet });
  }

  _bettingComplete() {
    const handPlayers = this.getHandPlayers();

    for (const player of handPlayers) {
      if (player.isAllIn) continue;
      if (!this.playersActedThisStreet.has(player.userId)) return false;
      if (player.currentBet < this.currentBet) return false;
    }

    return true;
  }

  _advanceCurrentPlayer() {
    const handPlayers = this.getHandPlayers()
      .filter(p => !p.isAllIn)
      .sort((a, b) => a.seatNumber - b.seatNumber);

    if (handPlayers.length === 0) return;

    // Find first seat numerically greater than current (works even if current player folded)
    const afterCurrent = handPlayers.filter(p => p.seatNumber > this.currentPlayerSeat);
    this.currentPlayerSeat = afterCurrent.length > 0
      ? afterCurrent[0].seatNumber
      : handPlayers[0].seatNumber;
  }

  // ─── Street Advancement ─────────────────────────────────────────────────

  advanceStreet() {
    // Collect bets into pot (already in pot, just reset current bets)
    for (const player of this.players.values()) {
      player.currentBet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.playersActedThisStreet = new Set();

    const handPlayers = this.getHandPlayers();

    if (handPlayers.length === 1) {
      return this._awardPotToLastPlayer();
    }

    const currentStreetIndex = STREETS.indexOf(this.currentStreet);

    if (currentStreetIndex === STREETS.length - 1) {
      // After river, go to showdown
      return this.showdown();
    }

    // All remaining players are all-in, run out the board
    const nonAllIn = handPlayers.filter(p => !p.isAllIn);
    const runItOut = nonAllIn.length === 0;

    this.currentStreet = STREETS[currentStreetIndex + 1];
    const cardsNeeded = STREET_COMMUNITY_CARDS[this.currentStreet] - this.communityCards.length;

    if (cardsNeeded > 0) {
      const newCards = this.deck.deal(cardsNeeded);
      this.communityCards.push(...newCards);
    }

    if (runItOut) {
      // All players are all-in — return this street for async staged runout with delays
      if (this.currentStreet === 'river') {
        return this.showdown();
      }
      return { action: 'all_in_runout', street: this.currentStreet, communityCards: this.communityCards };
    }

    // Set first to act (first active player left of dealer)
    this._setFirstToActPostFlop();

    console.log(`[poker] → ${this.currentStreet} | community:${this.communityCards.length} pot:${this.pot} firstAct:${this.currentPlayerSeat}`);

    return {
      action: 'street_changed',
      street: this.currentStreet,
      communityCards: this.communityCards,
      currentPlayerSeat: this.currentPlayerSeat
    };
  }

  _setFirstToActPostFlop() {
    const handPlayers = this.getHandPlayers()
      .filter(p => !p.isAllIn)
      .sort((a, b) => a.seatNumber - b.seatNumber);

    if (handPlayers.length === 0) return;

    // First active player clockwise from dealer
    const dealerIndex = handPlayers.findIndex(p => p.seatNumber > this.dealerSeat);
    if (dealerIndex === -1) {
      this.currentPlayerSeat = handPlayers[0].seatNumber;
    } else {
      this.currentPlayerSeat = handPlayers[dealerIndex].seatNumber;
    }
  }

  // ─── Showdown / Winner Determination ───────────────────────────────────

  showdown() {
    const handPlayers = this.getHandPlayers();
    this.handActive = false;

    // Calculate side pots
    const pots = this._calculatePots();

    const results = [];

    for (const pot of pots) {
      const eligiblePlayers = pot.eligiblePlayers;

      if (eligiblePlayers.length === 1) {
        const soloPlayer = eligiblePlayers[0];
        let soloHand = null;
        try {
          soloHand = this.gameType === 'plo'
            ? evaluatePLOHand(soloPlayer.holeCards, this.communityCards)
            : evaluateBestHand(soloPlayer.holeCards, this.communityCards);
        } catch (_) {}
        results.push({ winner: soloPlayer, amount: pot.amount, handResult: soloHand, isMainPot: pot.isMain });
        continue;
      }

      // Evaluate each eligible player's hand
      const playerHands = eligiblePlayers.map(player => {
        let handResult;
        if (this.gameType === 'plo') {
          handResult = evaluatePLOHand(player.holeCards, this.communityCards);
        } else {
          handResult = evaluateBestHand(player.holeCards, this.communityCards);
        }
        return { player, handResult };
      });

      // Sort by hand strength
      playerHands.sort((a, b) => -compareHandResults(a.handResult, b.handResult));

      // Find all tied winners
      const bestHand = playerHands[0].handResult;
      const winners = playerHands.filter(ph => compareHandResults(ph.handResult, bestHand) === 0);

      const splitAmount = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - (splitAmount * winners.length);
      const isSplit = winners.length > 1;

      // Extra chip goes to player left of dealer among tied players
      let extraChipUserId = winners[0].player.userId;
      if (isSplit && remainder > 0) {
        const allSeats = Array.from(this.seats.keys()).sort((a, b) => a - b);
        const dealerIdx = allSeats.indexOf(this.dealerSeat);
        const winnerIds = new Set(winners.map(w => w.player.userId));
        for (let i = 1; i <= allSeats.length; i++) {
          const uid = this.seats.get(allSeats[(dealerIdx + i) % allSeats.length]);
          if (winnerIds.has(uid)) { extraChipUserId = uid; break; }
        }
      }

      winners.forEach(w => {
        results.push({
          winner: w.player,
          amount: splitAmount + (w.player.userId === extraChipUserId ? remainder : 0),
          handResult: w.handResult,
          isMainPot: pot.isMain,
          isSplit
        });
      });
    }

    // Apply rake and jackpot contribution to main pot
    const totalPot = results.reduce((sum, r) => sum + r.amount, 0);
    const rakeAmount = Math.min(
      Math.floor(totalPot * (this.rakePercent / 100)),
      this.rakeCap
    );
    // Flat $1 contribution per hand (Hold'em only, only when pot covers it)
    const jackpotContrib = (this.gameType !== 'plo' && totalPot > rakeAmount) ? this.jackpotFlatContrib : 0;
    this.rakeCollected = rakeAmount;
    this.jackpotContribution = jackpotContrib;

    // Award chips
    for (const result of results) {
      result.winner.chips += result.amount;
    }

    // Deduct rake from first winner's chips
    if (results.length > 0) {
      const deductFrom = results[0].winner;
      deductFrom.chips = Math.max(0, deductFrom.chips - rakeAmount - jackpotContrib);
    }

    // Check jackpot
    const bestOverall = results.find(r => r.handResult);
    if (bestOverall && this.onJackpotCheck) {
      this.onJackpotCheck(bestOverall.handResult.rank, bestOverall.winner.userId);
    }

    // Pot breakdown for side-pot display (only when more than 1 pot)
    const potBreakdown = pots.length > 1
      ? pots.map((p, i) => ({ label: i === 0 ? 'Main Pot' : `Side Pot ${i}`, amount: p.amount }))
      : null;

    // Reveal all non-folded players' hole cards at showdown
    const allHoleCards = {};
    for (const player of this.players.values()) {
      if (!player.hasFolded && player.holeCards.length) {
        allHoleCards[player.userId] = player.holeCards;
      }
    }

    const handResult = {
      winners: results,
      communityCards: this.communityCards,
      rakeCollected: rakeAmount,
      jackpotContribution: jackpotContrib,
      handNumber: this.handNumber,
      pot: totalPot,
      potBreakdown,
      allHoleCards,
      history: [...this.handHistory]
    };

    if (this.onHandEnd) {
      this.onHandEnd(handResult);
    }

    return { action: 'showdown', result: handResult };
  }

  _calculatePots() {
    // Build side pots based on all-in amounts
    const allPlayers = Array.from(this.players.values()).filter(p => !p.hasFolded || p.totalBetThisHand > 0);

    if (this.sidePots.length === 0 && this.allInPlayers.size === 0) {
      // Simple case - no side pots
      return [{
        amount: this.pot,
        eligiblePlayers: this.getHandPlayers(),
        isMain: true
      }];
    }

    // Complex side pot calculation
    const contributions = allPlayers
      .map(p => ({ player: p, contributed: p.totalBetThisHand }))
      .filter(c => c.contributed > 0)
      .sort((a, b) => a.contributed - b.contributed);

    const pots = [];
    let previousLevel = 0;

    const uniqueLevels = [...new Set(contributions.map(c => c.contributed))];

    for (const level of uniqueLevels) {
      const levelContrib = level - previousLevel;
      const eligiblePlayers = contributions
        .filter(c => c.contributed >= level && !allPlayers.find(p => p.userId === c.player.userId)?.hasFolded)
        .map(c => c.player);

      const potAmount = levelContrib * contributions.filter(c => c.contributed >= level).length;

      if (potAmount > 0) {
        pots.push({
          amount: potAmount,
          eligiblePlayers: eligiblePlayers.filter(p => !p.hasFolded),
          isMain: pots.length === 0
        });
      }

      previousLevel = level;
    }

    // If no complex pots were built, use the simple pot
    if (pots.length === 0) {
      return [{
        amount: this.pot,
        eligiblePlayers: this.getHandPlayers(),
        isMain: true
      }];
    }

    // Verify total matches pot
    const calculatedTotal = pots.reduce((sum, p) => sum + p.amount, 0);
    if (calculatedTotal < this.pot && pots.length > 0) {
      pots[pots.length - 1].amount += (this.pot - calculatedTotal);
    }

    return pots;
  }

  _awardPotToLastPlayer() {
    const handPlayers = this.getHandPlayers();
    if (handPlayers.length !== 1) return null;

    const winner = handPlayers[0];
    const rakeAmount = Math.min(
      Math.floor(this.pot * (this.rakePercent / 100)),
      this.rakeCap
    );
    const jackpotContrib = (this.gameType !== 'plo' && this.pot > rakeAmount) ? this.jackpotFlatContrib : 0;

    winner.chips += this.pot - rakeAmount - jackpotContrib;
    this.rakeCollected = rakeAmount;
    this.jackpotContribution = jackpotContrib;
    this.handActive = false;

    // Rabbit hunt: cards that would have been dealt if all hands ran out
    const communityNeeded = Math.max(0, 5 - this.communityCards.length);
    const rabbitCards = this.deck.cards.slice(0, communityNeeded);
    const foldedCards = {};
    for (const p of this.players.values()) {
      if (p.hasFolded && p.holeCards.length > 0) {
        foldedCards[p.userId] = { cards: p.holeCards, username: p.username };
      }
    }

    const handResult = {
      winners: [{ winner, amount: this.pot - rakeAmount - jackpotContrib }],
      communityCards: this.communityCards,
      rakeCollected: rakeAmount,
      jackpotContribution: jackpotContrib,
      handNumber: this.handNumber,
      pot: this.pot,
      folded: true,
      rabbitCards,
      foldedCards
    };

    if (this.onHandEnd) {
      this.onHandEnd(handResult);
    }

    return { action: 'hand_ended', result: handResult };
  }

  // ─── Shot Clock ─────────────────────────────────────────────────────────

  startShotClock(userId) {
    this.clearShotClock();

    const warningTime = Math.max(0, this.shotClockDuration - 10) * 1000;
    const totalTime = this.shotClockDuration * 1000;

    if (this.onBroadcast) {
      this.onBroadcast('shot_clock_start', {
        userId,
        seconds: this.shotClockDuration,
        seatNumber: this.currentPlayerSeat
      });
    }

    this.shotClockWarningTimer = setTimeout(() => {
      if (this.onBroadcast) {
        this.onBroadcast('shot_clock_warning', { userId, secondsLeft: 10 });
      }
    }, warningTime);

    this.shotClockTimer = setTimeout(() => {
      if (this.onShotClockExpired) {
        this.onShotClockExpired(userId);
      }
    }, totalTime);
  }

  clearShotClock() {
    if (this.shotClockTimer) {
      clearTimeout(this.shotClockTimer);
      this.shotClockTimer = null;
    }
    if (this.shotClockWarningTimer) {
      clearTimeout(this.shotClockWarningTimer);
      this.shotClockWarningTimer = null;
    }
  }

  // ─── Break System ───────────────────────────────────────────────────────

  requestBreak(userId) {
    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (player.breakPassesUsed >= 3) throw new Error('No break passes remaining');
    if (player.isSittingOut) throw new Error('Already sitting out');

    player.isSittingOut = true;
    player.breakPassesUsed++;
    player.breakStartHandNumber = this.handNumber; // used to detect missed blinds on return
    return { breakPassesRemaining: 3 - player.breakPassesUsed };
  }

  returnFromBreak(userId) {
    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (!player.isSittingOut) throw new Error('Not sitting out');

    // If hands were played while the player was away, they must post the big blind
    // before being dealt in (standard poker fairness rule: can't skip blinds).
    const handsMissed = this.handNumber > (player.breakStartHandNumber ?? this.handNumber);
    if (handsMissed) {
      player.mustPostBlind = true;
      // Stay sitting out until they explicitly post via postBlind()
      return {
        breakPassesRemaining: 3 - player.breakPassesUsed,
        mustPostBlind: true,
        mustPostAmount: this.bigBlind
      };
    }

    player.isSittingOut = false;
    return { breakPassesRemaining: 3 - player.breakPassesUsed, mustPostBlind: false };
  }

  postBlind(userId) {
    const player = this.players.get(userId);
    if (!player) throw new Error('Player not found');
    if (!player.mustPostBlind) throw new Error('No blind post required');
    if (this.handActive) throw new Error('Cannot post blind during an active hand');

    // Chips are deducted at hand start in _postBlinds (dead-money entry fee).
    // Here we just stage the amount and return the player to active status.
    player.pendingBlindPost = this.bigBlind;
    player.mustPostBlind = false;
    player.isSittingOut = false;
    return { amount: this.bigBlind };
  }

  // ─── Jackpot ────────────────────────────────────────────────────────────

  checkJackpot(handRank, userId) {
    // Delegated to external handler via onJackpotCheck callback
    if (this.onJackpotCheck) {
      this.onJackpotCheck(handRank, userId);
    }
  }

  // ─── State Getters ──────────────────────────────────────────────────────

  getPublicState() {
    const players = Array.from(this.players.values()).map(p => ({
      userId: p.userId,
      username: p.username,
      chips: p.chips,
      seatNumber: p.seatNumber,
      currentBet: p.currentBet,
      totalBetThisHand: p.totalBetThisHand,
      hasFolded: p.hasFolded,
      isAllIn: p.isAllIn,
      isSittingOut: p.isSittingOut,
      breakPassesRemaining: 3 - p.breakPassesUsed,
      isConnected: p.isConnected,
      cardCount: p.holeCards.length,
      mustPostBlind: p.mustPostBlind,   // must post BB before next hand
      joinedMidHand: p.joinedMidHand,   // waiting for current hand to end
      // Don't reveal hole cards in public state
      holeCards: p.hasFolded || !this.handActive ? [] : Array(p.holeCards.length).fill({ rank: '?', suit: '?' })
    }));

    return {
      tableId: this.tableId,
      tableName: this.tableName || this.tableId,
      gameType: this.gameType,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      handNumber: this.handNumber,
      handActive: this.handActive,
      currentStreet: this.currentStreet,
      communityCards: this.communityCards,
      pot: this.pot,
      sidePots: this.sidePots,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerSeat: this.dealerSeat,
      currentPlayerSeat: this.currentPlayerSeat,
      straddlePlayerSeat: this.straddlePlayerSeat,
      straddleEnabled: this.straddleEnabled,
      rabbitHuntEnabled: this.rabbitHuntEnabled,
      maxPlayers: this.maxPlayers,
      players
    };
  }

  getPlayerState(userId) {
    const publicState = this.getPublicState();
    const player = this.players.get(userId);

    if (!player) return publicState;

    // Replace this player's hole cards with actual cards
    publicState.players = publicState.players.map(p => {
      if (p.userId === userId) {
        return { ...p, holeCards: player.holeCards };
      }
      return p;
    });

    publicState.myUserId = userId;
    publicState.isMyTurn = this.currentPlayerSeat === player.seatNumber && this.handActive;
    publicState.canCheck = player.currentBet >= this.currentBet;
    publicState.callAmount = Math.max(0, this.currentBet - player.currentBet);
    publicState.minRaiseAmount = this.currentBet + this.minRaise;
    publicState.maxRaiseAmount = player.chips + player.currentBet;

    if (this.gameType === 'plo') {
      const callAmount = this.currentBet - player.currentBet;
      publicState.potLimitMax = this.pot + callAmount + (this.pot + callAmount);
      publicState.maxRaiseAmount = Math.min(publicState.maxRaiseAmount, publicState.potLimitMax);
    }

    return publicState;
  }

  // ─── Utility ────────────────────────────────────────────────────────────

  getPotLimitMax() {
    const player = this.getPlayerBySeat(this.currentPlayerSeat);
    if (!player) return 0;
    const callAmount = this.currentBet - player.currentBet;
    return this.pot + callAmount + (this.pot + callAmount);
  }

  destroy() {
    this.clearShotClock();
  }
}

module.exports = { PokerGame };
