'use strict';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

class Deck {
  constructor() {
    this.cards = [];
    this.reset();
  }

  reset() {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({
          rank,
          suit,
          value: RANK_VALUES[rank]
        });
      }
    }
  }

  shuffle() {
    // Fisher-Yates shuffle
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    return this;
  }

  deal(n) {
    if (n > this.cards.length) {
      throw new Error(`Cannot deal ${n} cards, only ${this.cards.length} remaining`);
    }
    return this.cards.splice(0, n);
  }

  remaining() {
    return this.cards.length;
  }

  static cardToString(card) {
    return `${card.rank}${card.suit}`;
  }

  static parseCard(str) {
    // Parse a card string like "A♠" or "10♥"
    const rank = str.slice(0, -1);
    const suit = str.slice(-1);
    if (!RANK_VALUES[rank] || !SUITS.includes(suit)) {
      throw new Error(`Invalid card string: ${str}`);
    }
    return { rank, suit, value: RANK_VALUES[rank] };
  }
}

module.exports = { Deck, SUITS, RANKS, RANK_VALUES };
