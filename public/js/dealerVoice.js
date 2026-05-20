'use strict';
/* ─── Dealer Voice Announcer ───────────────────────────────────────────────── *
 * Narrates game events. Uses server-side Google TTS proxy (/api/tts) when
 * available (Neural2-D voice), falls back to Web Speech API.
 *
 * Public API:
 *   DealerVoice.toggle()            — flip on/off, persists in localStorage
 *   DealerVoice.isEnabled()         — current state
 *   DealerVoice.onHandStarted(data, gameState)
 *   DealerVoice.onActionRequired(data, gameState)
 *   DealerVoice.onPlayerActed(data)
 *   DealerVoice.onStreetChanged(data)
 *   DealerVoice.onHandEnded(result)
 *** */

window.DealerVoice = (() => {
  const LS_KEY = 'rp_dealer_voice';

  let _enabled    = localStorage.getItem(LS_KEY) !== 'false';
  let _queue      = [];
  let _busy       = false;
  let _lastHandNum = -1;
  let _gttsAvail  = null; // null = unknown, true = working, false = unavailable
  const _audioCache = new Map(); // text → blob URL

  // ─── Google TTS ─────────────────────────────────────────────────────────
  async function _gttsSpeak(text) {
    if (_gttsAvail === false) return false;

    // Try cache first
    if (_audioCache.has(text)) {
      return _playUrl(_audioCache.get(text));
    }

    try {
      const token = sessionStorage.getItem('rp_token');
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(4000)
      });

      if (res.status === 503) { _gttsAvail = false; return false; } // not configured
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      _gttsAvail = true;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      _audioCache.set(text, url);
      return _playUrl(url);
    } catch (e) {
      if (_gttsAvail === null) _gttsAvail = false; // first failure = mark unavailable
      return false;
    }
  }

  function _playUrl(url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => resolve(true);
      audio.play().catch(() => resolve(false));
    });
  }

  // ─── Web Speech fallback ─────────────────────────────────────────────────
  const WEB_PREFERRED = [
    'Google US English',
    'Alex',
    'Daniel',
    'Google UK English Male',
    'Microsoft David - English (United States)',
    'Microsoft David Desktop - English (United States)',
    'Microsoft Mark - English (United States)',
    'en-US-Neural2-D',
  ];

  let _webVoice = null;

  function _pickWebVoice() {
    if (!window.speechSynthesis) return null;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    for (const name of WEB_PREFERRED) {
      const v = voices.find(v => v.name === name);
      if (v) return v;
    }
    const male = voices.find(v => v.lang.startsWith('en') && /male/i.test(v.name));
    if (male) return male;
    return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
  }

  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => { _webVoice = _pickWebVoice(); };
    _webVoice = _pickWebVoice();
  }

  function _webSpeak(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve(false);
      const utt = new SpeechSynthesisUtterance(text);
      if (_webVoice) utt.voice = _webVoice;
      utt.rate = 0.82;
      utt.pitch = 0.70;
      utt.volume = 1.0;
      utt.onend = utt.onerror = () => resolve(true);
      speechSynthesis.speak(utt);
    });
  }

  // ─── Queue ───────────────────────────────────────────────────────────────
  async function _drain() {
    if (_busy || !_queue.length || !_enabled) return;
    _busy = true;
    const text = _queue.shift();

    const done = await _gttsSpeak(text);
    if (!done) await _webSpeak(text);

    _busy = false;
    _drain();
  }

  function speak(text, priority) {
    if (!_enabled) return;
    if (priority) {
      if (window.speechSynthesis) speechSynthesis.cancel();
      _queue = [];
      _busy  = false;
    }
    _queue.push(text);
    setTimeout(_drain, priority ? 80 : 0);
  }

  // ─── Phrases ─────────────────────────────────────────────────────────────
  const DEAL_INTROS = [
    "Cards in the air, let's get it",
    "Shuffling up and dealing",
    "New hand, let's go",
    "Alright, let's play some cards",
    "Here we go, fresh hand",
  ];

  const ACTION_PROMPTS = [
    (n) => `${n}, whatchu gonna do`,
    (n) => `${n}, it's on you`,
    (n) => `Action to ${n}`,
    (n) => `${n}, your move`,
    (n) => `Clock's ticking, ${n}`,
  ];

  function _rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ─── Game event handlers ─────────────────────────────────────────────────
  function onHandStarted({ handNumber, dealerSeat }, gameState) {
    if (_lastHandNum === handNumber) return;
    _lastHandNum = handNumber;

    speak(_rand(DEAL_INTROS), true);

    if (!gameState) return;

    const active = (gameState.players || [])
      .filter(p => !p.isSittingOut)
      .sort((a, b) => a.seatNumber - b.seatNumber);

    if (active.length < 2) return;

    const seats = active.map(p => p.seatNumber);
    const dIdx  = seats.indexOf(dealerSeat);
    let sbIdx, bbIdx;

    if (active.length === 2) {
      sbIdx = dIdx >= 0 ? dIdx : 0;
      bbIdx = (sbIdx + 1) % active.length;
    } else {
      sbIdx = dIdx >= 0 ? (dIdx + 1) % active.length : 0;
      bbIdx = (sbIdx + 1) % active.length;
    }

    const sbName = active[sbIdx]?.username;
    const bbName = active[bbIdx]?.username;
    if (sbName) speak(`${sbName}, small blind`);
    if (bbName) speak(`${bbName}, big blind`);
  }

  function onActionRequired({ seatNumber }, gameState) {
    if (!gameState) return;
    const player = (gameState.players || []).find(p => p.seatNumber === seatNumber);
    if (!player) return;
    speak(_rand(ACTION_PROMPTS)(player.username));
  }

  function onPlayerActed({ action, username, isAllIn, amount }) {
    if (!username) return;
    if (isAllIn) {
      speak(`${username} is all in`);
    } else if (action === 'fold') {
      speak(`${username} folds`);
    } else if (action === 'raise' && amount) {
      speak(`${username} raises`);
    }
  }

  function onStreetChanged({ street }) {
    switch (street) {
      case 'flop':  speak('Dealing the flop', true); break;
      case 'turn':  speak('Turn card', true);        break;
      case 'river': speak('The river', true);        break;
    }
  }

  function onHandEnded(result) {
    if (result.isSplitPot) {
      speak('Split pot, chop it up', true);
    } else if (result.winners?.length) {
      speak(`${result.winners[0].username} wins`, true);
    }
  }

  // ─── Toggle ──────────────────────────────────────────────────────────────
  function toggle() {
    _enabled = !_enabled;
    localStorage.setItem(LS_KEY, _enabled ? 'true' : 'false');
    if (!_enabled) {
      if (window.speechSynthesis) speechSynthesis.cancel();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _updateBtn);
  } else {
    setTimeout(_updateBtn, 0);
  }

  return { speak, toggle, isEnabled, onHandStarted, onActionRequired, onPlayerActed, onStreetChanged, onHandEnded };
})();
