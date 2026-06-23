'use strict';
/* Poker Sound Engine — arcade/video-game style, Web Audio API, zero external files */

window.Sound = (() => {
  let _ctx = null;
  let _muted = localStorage.getItem('rp_sfx_muted') === '1';
  let _theme = localStorage.getItem('rp_sfx_theme') || 'classic';

  function ctx() {
    if (!_ctx) {
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  function isMuted() { return _muted; }
  function setMuted(v) {
    _muted = !!v;
    localStorage.setItem('rp_sfx_muted', _muted ? '1' : '0');
    _updateBtn();
  }
  function toggle() { setMuted(!_muted); return _muted; }

  function getTheme() { return _theme; }
  function setTheme(t) {
    _theme = ['classic', 'modern', 'silent'].includes(t) ? t : 'classic';
    localStorage.setItem('rp_sfx_theme', _theme);
    if (_theme === 'silent') {
      _muted = true;
      localStorage.setItem('rp_sfx_muted', '1');
    } else {
      _muted = false;
      localStorage.setItem('rp_sfx_muted', '0');
    }
    _updateBtn();
    _updateThemeUI();
  }

  function _updateBtn() {
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
      const icon = _theme === 'silent' ? '🔕' : _muted ? '🔇' : '🔊';
      btn.textContent = icon;
      btn.title = _theme === 'silent' ? 'Silent mode' : (_muted ? 'Sounds off — click to enable' : 'Sounds on — click to mute');
    }
  }

  function _updateThemeUI() {
    const panel = document.getElementById('sound-theme-panel');
    if (!panel) return;
    ['classic', 'modern', 'silent'].forEach(t => {
      const btn = document.getElementById(`sfx-theme-${t}`);
      if (btn) btn.classList.toggle('active', _theme === t);
    });
  }

  function init() { _updateBtn(); _updateThemeUI(); }

  // ── Low-level helpers ──────────────────────────────────────────────

  function _osc(freq, type, t, dur, vol, freqEnd) {
    const c = ctx(); if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function _noise(t, dur, vol, fHigh = 4000, fLow = 2000) {
    const c = ctx(); if (!c) return;
    const len = Math.ceil(c.sampleRate * (dur + 0.06));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    const flt = c.createBiquadFilter();
    const g   = c.createGain();
    src.buffer = buf;
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(fHigh, t);
    flt.frequency.exponentialRampToValueAtTime(fLow, t + dur);
    flt.Q.value = 1.5;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + dur + 0.06);
  }

  // Arcade chip: bright square "ting" — snappier than realistic clink
  function _chip(t, vol = 0.22) {
    _osc(2200, 'square',   t, 0.055, vol,       1100);
    _osc(3300, 'triangle', t, 0.030, vol * 0.3, 1650);
  }

  // Heavy chip: wider, deeper thud for big stacks
  function _chipHeavy(t, vol = 0.26) {
    _osc(1400, 'square',   t, 0.070, vol,       700);
    _osc(2100, 'triangle', t, 0.040, vol * 0.35, 1050);
    _noise(t, 0.04, vol * 0.2, 6000, 3000);
  }

  // ── Public sounds ──────────────────────────────────────────────────

  function cardDeal() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Crisp card-snap: sharp noise burst + high "zip" tone
    _noise(now,        0.06, 0.18, 9000, 4000);
    _osc(3200, 'square', now, 0.055, 0.10, 1600);
    _noise(now + 0.08, 0.05, 0.12, 8000, 3500);
  }

  function chipBet(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 1 : amount >= 1000 ? 5 : amount >= 500 ? 4 : amount >= 200 ? 3 : amount >= 50 ? 2 : 1;
    const fn = n >= 3 ? _chipHeavy : _chip;
    for (let i = 0; i < n; i++) fn(now + i * 0.050, 0.22 - i * 0.01);
  }

  function potSlide() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Rapid chip cascade + rising power-up sweep
    for (let i = 0; i < 8; i++) _chipHeavy(now + i * 0.044, 0.22 - i * 0.01);
    _osc(220, 'sawtooth', now,        0.55, 0.14, 880);
    _osc(440, 'square',   now + 0.18, 0.35, 0.10, 1760);
  }

  function fold() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Descending "bworp" — classic game dismiss
    _osc(700, 'sawtooth', now,        0.18, 0.13, 180);
    _osc(500, 'square',   now + 0.05, 0.14, 0.08, 130);
    _noise(now, 0.12, 0.08, 3000, 600);
  }

  function check() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Double-tap UI confirm — satisfying two-beat "tik-tik"
    _osc(1400, 'square', now,        0.055, 0.16, 1400);
    _osc(1600, 'square', now + 0.07, 0.045, 0.13, 1600);
  }

  function call() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Two-chip "ting ting" with brief rising tail
    _chip(now,        0.26);
    _chip(now + 0.06, 0.20);
    _osc(1100, 'triangle', now, 0.12, 0.07, 2200);
  }

  function raise(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 3 : Math.min(5, Math.max(3, Math.round(Math.log10(Math.max(10, amount)) * 1.4)));
    // Escalating chip stack + power-up glide
    for (let i = 0; i < n; i++) _chipHeavy(now + i * 0.048, 0.26 - i * 0.02);
    _osc(440, 'sawtooth', now, 0.28, 0.11, 1760);
  }

  function allIn() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // All chips slam down + big game-over build
    for (let i = 0; i < 10; i++) _chipHeavy(now + i * 0.042, 0.28 - i * 0.01);
    _osc(110, 'sawtooth', now + 0.30, 0.70, 0.22, 55);
    _osc(220, 'square',   now + 0.30, 0.55, 0.16, 110);
    _osc(440, 'square',   now + 0.40, 0.40, 0.12, 880);
    _noise(now + 0.30, 0.50, 0.12, 5000, 800);
  }

  function win() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // 8-bit victory fanfare: C-E-G-C-E ascending arpeggio + chip rain
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => {
      _osc(f, 'square', now + i * 0.085, 0.35, 0.17);
      _osc(f * 2, 'triangle', now + i * 0.085, 0.20, 0.06);
    });
    for (let i = 0; i < 10; i++) _chip(now + 0.04 + i * 0.065, 0.16 - i * 0.01);
    // Final "ding" punch
    _osc(1319, 'square', now + notes.length * 0.085, 0.45, 0.20);
  }

  function timerTick() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Sharp game-clock tick
    _osc(2000, 'square', now, 0.035, 0.09);
  }

  function newHand() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Three-note game-start chime: G-A-B
    [784, 880, 988].forEach((f, i) => {
      _osc(f, 'square',   now + i * 0.08, 0.14, 0.13);
      _osc(f, 'triangle', now + i * 0.08, 0.10, 0.05);
    });
  }

  function notification() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    // Rising two-tone ping — "your turn" alert
    _osc(1320, 'square',   now,        0.18, 0.18, 1760);
    _osc(1760, 'square',   now + 0.12, 0.16, 0.15, 2640);
    _osc(1320, 'triangle', now,        0.18, 0.06, 1760);
  }

  return {
    isMuted, setMuted, toggle, init,
    getTheme, setTheme,
    cardDeal, chipBet, potSlide,
    fold, check, call, raise, allIn,
    win, timerTick, newHand, notification
  };
})();
