'use strict';

// In-memory maintenance banner state.
// Resets on server restart — that's intentional (a fresh deploy means the site is back up).
let bannerActive  = false;
let bannerMessage = 'Boston Poker Club is undergoing maintenance. Some features may be temporarily unavailable.';

module.exports = {
  getState: () => ({ active: bannerActive, message: bannerMessage }),
  setState: (active, message) => {
    bannerActive = !!active;
    if (typeof message === 'string' && message.trim()) bannerMessage = message.trim();
  }
};
