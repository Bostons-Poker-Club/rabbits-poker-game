'use strict';
/* ─── Dealer Voice Announcer ───────────────────────────────────────────────── *
 * Narrates game events using Web Speech API (SpeechSynthesis).
 * Prefer a deep male English voice (Google UK English Male, Microsoft David,
 * Alex on macOS, etc.).  Falls back gracefully when speech isn't supported.
 *
 * Usage:
 *   DealerVoice.toggle()          — flip on/off, persists in localStorage
 *   DealerVoice.isEnabled()       — current state
 *   DealerVoice.onHandStarted()   — call from hand_started socket event
 *   DealerVoice.onActionRequired()— call from action_required socket event
 *   DealerVoice.onPlayerActed()   — call from player_acted socket event
 *   DealerVoice.onStreetChanged() — call from street_changed socket event
 *   DealerVoice.onHandEnded()     — call from hand_ended socket event
 *** */

window.DealerVoice = (() => {
  const LS_KEY = 'rp_dealer_voice';

  let _enabled   = localStorage.getItem(LS_KEY) !== 'false'; // default ON
  let _voice     = null;
  let _queue     = [];
  let _busy      = false;
  let _lastHandNum = -1;

  // ─── Voice selection ────────────────────────────────────────────────────
  // Ranked list of preferred deep/male voice names across platforms.
  const PREFERRED = [
    'Google UK English Male',
    'Microsoft David - English (United States)',
    'Microsoft David Desktop - English (United States)',
    'Alex',          // macOS
    'Daniel',        // macOS UK
    'Google US English',
    'Microsoft Mark - English (United States)',
    'en-US-Neural2-D',
  ];

  function _pickVoice() {
    if (!window.speechSynthesis) return null;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;

    for (const name of PREFERRED) {
      const v = voices.find(v => v.name === name);
      if (v) return v;
    }
    // Any male English voice
    const male = voices.find(v => v.lang.startsWith('en') && /male/i.test(v.name));
    if (male) return male;
    // Any English voice
    return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
  }

  function _initVoice() {
    _voice = _pickVoice();
  }

  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = _initVoice;
    _initVoice();
  }

  // ─── Speech queue ────────────────────────────────────────────────────────
  function _drain() {
    if (_busy || !_queue.length || !_enabled) return;
    const text = _queue.shift();
    const utt  = new SpeechSynthesisUtterance(text);
    if (_voice) utt.voice = _voice;
    utt.rate   = 0.88;   // deliberate pace
    utt.pitch  = 0.80;   // lower = deeper
    utt.volume = 1.0;
    _busy = true;
    utt.onend = utt.onerror = () => { _busy = false; _drain(); };
    speechSynthesis.speak(utt);
  }

  // speak(text, priority) — priority cancels current speech and clears queue
  function speak(text, priority) {
    if (!_enabled || !window.speechSynthesis) return;
    if (priority) {
      speechSynthesis.cancel();
      _queue = [];
      _busy  = false;
    }
    _queue.push(text);
    // Small delay after cancel to let the engine settle (Chrome quirk)
    setTimeout(_drain, priority ? 80 : 0);
  }

  // ─── Game event handlers ─────────────────────────────────────────────────

  // hand_started fires AFTER game_state, so gameState already contains
  // the new hand's data (blinds posted, dealer seat set).
  function onHandStarted({ handNumber, dealerSeat }, gameState) {
    if (_lastHandNum === handNumber) return;
    _lastHandNum = handNumber;

    speak('Shuffling up and dealing', true);

    if (!gameState) return;

    // Identify SB and BB from dealer position + active player order
    const active = (gameState.players || [])
      .filter(p => !p.isSittingOut)
      .sort((a, b) => a.seatNumber - b.seatNumber);

    if (active.length < 2) return;

    const seats    = active.map(p => p.seatNumber);
    const dIdx     = seats.indexOf(dealerSeat);
    let sbIdx, bbIdx;

    if (active.length === 2) {
      // Heads-up: dealer is SB
      sbIdx = dIdx >= 0 ? dIdx : 0;
      bbIdx = (sbIdx + 1) % active.length;
    } else {
      sbIdx = dIdx >= 0 ? (dIdx + 1) % active.length : 0;
      bbIdx = (sbIdx + 1) % active.length;
    }

    const sbName = active[sbIdx]?.username;
    const bbName = active[bbIdx]?.username;

    if (sbName) speak(`${sbName}, you're the small blind`);
    if (bbName) speak(`${bbName}, you're the big blind`);
  }

  function onActionRequired({ seatNumber }, gameState) {
    if (!gameState) return;
    const player = (gameState.players || []).find(p => p.seatNumber === seatNumber);
    if (!player) return;
    speak(`${player.username}, it's on you`);
  }

  function onPlayerActed({ action, username, isAllIn }) {
    if (!username) return;
    if (isAllIn) {
      speak(`${username} is all in!`);
    } else if (action === 'fold') {
      speak(`${username} folds`);
    }
  }

  function onStreetChanged({ street }) {
    switch (street) {
      case 'flop':  speak('Here comes the flop', true); break;
      case 'turn':  speak('The turn card',        true); break;
      case 'river': speak('And the river',         true); break;
    }
  }

  function onHandEnded(result) {
    if (result.isSplitPot) {
      speak('We have a split pot', true);
    } else if (result.winners?.length) {
      speak(`${result.winners[0].username} wins the pot`, true);
    }
  }

  // ─── Toggle ──────────────────────────────────────────────────────────────
  function toggle() {
    _enabled = !_enabled;
    localStorage.setItem(LS_KEY, _enabled ? 'true' : 'false');
    if (!_enabled && window.speechSynthesis) {
      speechSynthesis.cancel();
      _queue = [];
      _busy  = false;
    }
    _updateBtn();
    return _enabled;
  }

  function isEnabled() { return _enabled; }

  function _updateBtn() {
    const btn = document.getElementById('voice-toggle-btn');
    if (!btn) return;
    btn.innerHTML     = _enabled ? '🔈 Voice' : '🔇 Voice';
    btn.style.opacity = _enabled ? '1' : '0.5';
    btn.title         = _enabled ? 'Dealer voice on — click to mute' : 'Dealer voice muted — click to enable';
  }

  // Sync button once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _updateBtn);
  } else {
    setTimeout(_updateBtn, 0);
  }

  return { speak, toggle, isEnabled, onHandStarted, onActionRequired, onPlayerActed, onStreetChanged, onHandEnded };
})();
