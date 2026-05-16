'use strict';
/* Poker Sound Engine — Web Audio API synthesis, zero external files */

window.Sound = (() => {
  let _ctx = null;
  let _muted = localStorage.getItem('rp_sfx_muted') === '1';
  let _theme = localStorage.getItem('rp_sfx_theme') || 'classic'; // 'classic' | 'modern' | 'silent'

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
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
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
    const g = c.createGain();
    src.buffer = buf;
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(fHigh, t);
    flt.frequency.exponentialRampToValueAtTime(fLow, t + dur);
    flt.Q.value = 1.2;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + dur + 0.06);
  }

  // Classic chip click: pitched "tik" with frequency drop
  function _chip(t, vol = 0.28) {
    _osc(1500, 'sine', t, 0.075, vol,      520);
    _osc(2200, 'sine', t, 0.040, vol * 0.25, 900);
  }

  // Modern chip: sharp triangle click
  function _chipM(t, vol = 0.22) {
    _osc(2400, 'triangle', t, 0.050, vol,      1200);
    _osc(3600, 'triangle', t, 0.025, vol * 0.3, 1800);
  }

  // ── Public sounds ──────────────────────────────────────────────────

  function cardDeal() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(1200, 'triangle', now,        0.05, 0.10, 2400);
      _osc(1600, 'triangle', now + 0.06, 0.04, 0.08, 3200);
    } else {
      _noise(now,        0.09, 0.14, 5000, 2800);
      _noise(now + 0.11, 0.08, 0.10, 4500, 2400);
    }
  }

  function chipBet(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 1 : amount >= 1000 ? 5 : amount >= 500 ? 4 : amount >= 200 ? 3 : amount >= 50 ? 2 : 1;
    if (_theme === 'modern') {
      for (let i = 0; i < n; i++) _chipM(now + i * 0.055);
    } else {
      for (let i = 0; i < n; i++) _chip(now + i * 0.070);
    }
  }

  function potSlide() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      for (let i = 0; i < 7; i++) _chipM(now + i * 0.048, 0.18);
      _osc(180, 'triangle', now + 0.18, 0.45, 0.14, 60);
    } else {
      for (let i = 0; i < 7; i++) _chip(now + i * 0.058, 0.21);
      _noise(now, 0.40, 0.10, 800, 200);
      _osc(95, 'triangle', now + 0.18, 0.45, 0.18, 45);
    }
  }

  function fold() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(600, 'triangle', now, 0.18, 0.09, 200);
      _osc(400, 'triangle', now + 0.06, 0.12, 0.06, 150);
    } else {
      _noise(now, 0.15, 0.11, 2200, 700);
      _osc(200, 'sine', now + 0.04, 0.12, 0.07, 100);
    }
  }

  function check() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(800,  'triangle', now,        0.06, 0.15, 600);
      _osc(1000, 'triangle', now + 0.08, 0.05, 0.10, 750);
    } else {
      _osc(290, 'sine', now,        0.07, 0.18, 200);
      _osc(265, 'sine', now + 0.09, 0.06, 0.12, 180);
    }
  }

  function call() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _chipM(now, 0.26);
      _chipM(now + 0.065, 0.20);
    } else {
      _chip(now, 0.30);
      _chip(now + 0.075, 0.22);
    }
  }

  function raise(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 3 : Math.min(5, Math.max(3, Math.round(Math.log10(Math.max(10, amount)) * 1.4)));
    if (_theme === 'modern') {
      for (let i = 0; i < n; i++) _chipM(now + i * 0.055, 0.26 - i * 0.02);
      _osc(1200, 'triangle', now, 0.22, 0.07, 2400);
    } else {
      for (let i = 0; i < n; i++) _chip(now + i * 0.063, 0.30 - i * 0.025);
      _osc(420, 'sine', now, 0.28, 0.07, 680);
    }
  }

  function allIn() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      for (let i = 0; i < 10; i++) _chipM(now + i * 0.048, 0.26);
      _osc(300, 'triangle', now + 0.35, 0.80, 0.20, 80);
      _osc(600, 'triangle', now + 0.35, 0.50, 0.12, 150);
    } else {
      for (let i = 0; i < 10; i++) _chip(now + i * 0.058, 0.30);
      _osc(110, 'sawtooth', now + 0.35, 0.80, 0.22, 40);
      _osc(220, 'triangle', now + 0.35, 0.50, 0.12, 80);
    }
  }

  function win() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      [659, 880, 1047, 1319].forEach((f, i) => _osc(f, 'triangle', now + i * 0.100, 0.40, 0.20));
      for (let i = 0; i < 8; i++) _chipM(now + 0.05 + i * 0.075, 0.18);
    } else {
      [523, 659, 784, 1047].forEach((f, i) => _osc(f, 'sine', now + i * 0.115, 0.45, 0.22));
      for (let i = 0; i < 8; i++) _chip(now + 0.06 + i * 0.085, 0.19);
    }
  }

  function timerTick() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(1400, 'square', now, 0.045, 0.08);
    } else {
      _osc(900, 'square', now, 0.065, 0.10);
    }
  }

  function newHand() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(1000, 'triangle', now,        0.06, 0.08, 2000);
      _osc(1333, 'triangle', now + 0.07, 0.06, 0.07, 2666);
      _osc(1667, 'triangle', now + 0.14, 0.05, 0.06, 3333);
    } else {
      _noise(now,        0.08, 0.09, 5000, 2500);
      _noise(now + 0.09, 0.08, 0.08, 4500, 2200);
      _noise(now + 0.18, 0.08, 0.06, 4000, 2000);
    }
  }

  function notification() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    if (_theme === 'modern') {
      _osc(1320, 'triangle', now,        0.22, 0.16);
      _osc(1760, 'triangle', now + 0.14, 0.18, 0.12);
    } else {
      _osc(880,  'sine', now,        0.28, 0.18);
      _osc(1108, 'sine', now + 0.16, 0.25, 0.14);
    }
  }

  return {
    isMuted, setMuted, toggle, init,
    getTheme, setTheme,
    cardDeal, chipBet, potSlide,
    fold, check, call, raise, allIn,
    win, timerTick, newHand, notification
  };
})();
