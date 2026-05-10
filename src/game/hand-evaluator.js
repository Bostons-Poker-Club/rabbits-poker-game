'use strict';

// Hand ranks (higher = better)
const HAND_RANKS = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9
};

const HAND_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Royal Flush'
];

/**
 * Evaluate a 5-card hand
 * Returns { rank, name, tiebreakers }
 */
function evaluate5CardHand(cards) {
  if (cards.length !== 5) {
    throw new Error(`Expected 5 cards, got ${cards.length}`);
  }

  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // Check for straight
  let isStraight = false;
  let straightHighCard = values[0];

  // Normal straight check
  if (values[0] - values[4] === 4 && new Set(values).size === 5) {
    isStraight = true;
    straightHighCard = values[0];
  }

  // Wheel straight: A-2-3-4-5 (Ace plays low)
  if (!isStraight && values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
    isStraight = true;
    straightHighCard = 5;
  }

  // Count occurrences of each value
  const valueCounts = {};
  for (const v of values) {
    valueCounts[v] = (valueCounts[v] || 0) + 1;
  }

  // Sort by count desc, then value desc for tiebreaking
  const groups = Object.entries(valueCounts)
    .map(([val, cnt]) => ({ value: parseInt(val), count: cnt }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const counts = groups.map(g => g.count);

  // Royal Flush
  if (isFlush && isStraight && straightHighCard === 14) {
    return { rank: HAND_RANKS.ROYAL_FLUSH, name: 'Royal Flush', tiebreakers: [14] };
  }

  // Straight Flush
  if (isFlush && isStraight) {
    return { rank: HAND_RANKS.STRAIGHT_FLUSH, name: 'Straight Flush', tiebreakers: [straightHighCard] };
  }

  // Four of a Kind
  if (counts[0] === 4) {
    return {
      rank: HAND_RANKS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      tiebreakers: [groups[0].value, groups[1].value]
    };
  }

  // Full House
  if (counts[0] === 3 && counts[1] === 2) {
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      name: 'Full House',
      tiebreakers: [groups[0].value, groups[1].value]
    };
  }

  // Flush
  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, name: 'Flush', tiebreakers: values };
  }

  // Straight
  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, name: 'Straight', tiebreakers: [straightHighCard] };
  }

  // Three of a Kind
  if (counts[0] === 3) {
    return {
      rank: HAND_RANKS.THREE_OF_A_KIND,
      name: 'Three of a Kind',
      tiebreakers: [groups[0].value, groups[1].value, groups[2].value]
    };
  }

  // Two Pair
  if (counts[0] === 2 && counts[1] === 2) {
    return {
      rank: HAND_RANKS.TWO_PAIR,
      name: 'Two Pair',
      tiebreakers: [groups[0].value, groups[1].value, groups[2].value]
    };
  }

  // One Pair
  if (counts[0] === 2) {
    return {
      rank: HAND_RANKS.ONE_PAIR,
      name: 'One Pair',
      tiebreakers: [groups[0].value, groups[1].value, groups[2].value, groups[3].value]
    };
  }

  // High Card
  return { rank: HAND_RANKS.HIGH_CARD, name: 'High Card', tiebreakers: values };
}

/**
 * Get all combinations of k items from array
 */
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(combo => [first, ...combo]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/**
 * Evaluate best 5-card hand from 7 cards (Texas Hold'em)
 */
function evaluateBestHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  if (allCards.length < 5) {
    throw new Error(`Need at least 5 cards, got ${allCards.length}`);
  }

  const fiveCardCombos = combinations(allCards, 5);
  let bestHand = null;

  for (const combo of fiveCardCombos) {
    const hand = evaluate5CardHand(combo);
    if (!bestHand || compareHandResults(hand, bestHand) > 0) {
      bestHand = hand;
      bestHand.cards = combo;
    }
  }

  return bestHand;
}

/**
 * Evaluate best PLO hand (must use exactly 2 hole cards + 3 community cards)
 */
function evaluatePLOHand(holeCards, communityCards) {
  if (holeCards.length !== 4) {
    throw new Error(`PLO requires exactly 4 hole cards, got ${holeCards.length}`);
  }
  if (communityCards.length < 3) {
    throw new Error(`PLO requires at least 3 community cards, got ${communityCards.length}`);
  }

  const holeCombos = combinations(holeCards, 2);      // C(4,2) = 6
  const commCombos = combinations(communityCards, 3);  // C(5,3) = 10

  let bestHand = null;

  for (const holeCombo of holeCombos) {
    for (const commCombo of commCombos) {
      const fiveCards = [...holeCombo, ...commCombo];
      const hand = evaluate5CardHand(fiveCards);
      if (!bestHand || compareHandResults(hand, bestHand) > 0) {
        bestHand = hand;
        bestHand.cards = fiveCards;
        bestHand.holeCardsUsed = holeCombo;
        bestHand.communityCardsUsed = commCombo;
      }
    }
  }

  return bestHand;
}

/**
 * Compare two hand results
 * Returns: positive if hand1 wins, negative if hand2 wins, 0 if tie
 */
function compareHandResults(hand1, hand2) {
  if (hand1.rank !== hand2.rank) {
    return hand1.rank - hand2.rank;
  }

  // Same rank, compare tiebreakers
  const len = Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const t1 = hand1.tiebreakers[i] || 0;
    const t2 = hand2.tiebreakers[i] || 0;
    if (t1 !== t2) return t1 - t2;
  }

  return 0; // Perfect tie
}

/**
 * Compare two 5-card hands from hole cards + community
 * Returns: 1 if player1 wins, -1 if player2 wins, 0 if tie
 */
function compareHands(player1HoleCards, player2HoleCards, communityCards, gameType = 'holdem') {
  let hand1, hand2;

  if (gameType === 'plo') {
    hand1 = evaluatePLOHand(player1HoleCards, communityCards);
    hand2 = evaluatePLOHand(player2HoleCards, communityCards);
  } else {
    hand1 = evaluateBestHand(player1HoleCards, communityCards);
    hand2 = evaluateBestHand(player2HoleCards, communityCards);
  }

  const result = compareHandResults(hand1, hand2);
  if (result > 0) return { winner: 1, hand1, hand2 };
  if (result < 0) return { winner: -1, hand1, hand2 };
  return { winner: 0, hand1, hand2 };
}

module.exports = {
  HAND_RANKS,
  HAND_NAMES,
  evaluate5CardHand,
  evaluateBestHand,
  evaluatePLOHand,
  compareHandResults,
  compareHands,
  combinations
};
