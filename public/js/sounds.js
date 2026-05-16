'use strict';
/* Poker Sound Engine — Web Audio API synthesis, zero external files */

window.Sound = (() => {
  let _ctx = null;
  let _muted = localStorage.getItem('rp_sfx_muted') === '1';

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

  function _updateBtn() {
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
      btn.textContent = _muted ? '🔇' : '🔊';
      btn.title = _muted ? 'Sounds off — click to enable' : 'Sounds on — click to mute';
    }
  }
  // Call once DOM is ready
  function init() { _updateBtn(); }

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

  // Single chip click: pitched "tik" with frequency drop
  function _chip(t, vol = 0.28) {
    _osc(1500, 'sine',     t, 0.075, vol,      520);
    _osc(2200, 'sine',     t, 0.040, vol * 0.25, 900);
  }

  // ── Public sounds ──────────────────────────────────────────────────

  function cardDeal() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _noise(now,        0.09, 0.14, 5000, 2800);
    _noise(now + 0.11, 0.08, 0.10, 4500, 2400);
  }

  function chipBet(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 1 : amount >= 1000 ? 5 : amount >= 500 ? 4 : amount >= 200 ? 3 : amount >= 50 ? 2 : 1;
    for (let i = 0; i < n; i++) _chip(now + i * 0.070);
  }

  function potSlide() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    for (let i = 0; i < 7; i++) _chip(now + i * 0.058, 0.21);
    _noise(now, 0.40, 0.10, 800,  200);
    _osc(95, 'triangle', now + 0.18, 0.45, 0.18, 45);
  }

  function fold() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _noise(now, 0.15, 0.11, 2200, 700);
    _osc(200, 'sine', now + 0.04, 0.12, 0.07, 100);
  }

  function check() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _osc(290, 'sine', now,        0.07, 0.18, 200);
    _osc(265, 'sine', now + 0.09, 0.06, 0.12, 180);
  }

  function call() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _chip(now, 0.30);
    _chip(now + 0.075, 0.22);
  }

  function raise(amount) {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    const n = !amount ? 3 : Math.min(5, Math.max(3, Math.round(Math.log10(Math.max(10, amount)) * 1.4)));
    for (let i = 0; i < n; i++) _chip(now + i * 0.063, 0.30 - i * 0.025);
    _osc(420, 'sine', now, 0.28, 0.07, 680);
  }

  function allIn() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    for (let i = 0; i < 10; i++) _chip(now + i * 0.058, 0.30);
    _osc(110, 'sawtooth', now + 0.35, 0.80, 0.22, 40);
    _osc(220, 'triangle', now + 0.35, 0.50, 0.12, 80);
  }

  function win() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => _osc(f, 'sine', now + i * 0.115, 0.45, 0.22));
    for (let i = 0; i < 8; i++) _chip(now + 0.06 + i * 0.085, 0.19);
  }

  function timerTick() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _osc(900, 'square', now, 0.065, 0.10);
  }

  function newHand() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _noise(now,        0.08, 0.09, 5000, 2500);
    _noise(now + 0.09, 0.08, 0.08, 4500, 2200);
    _noise(now + 0.18, 0.08, 0.06, 4000, 2000);
  }

  function notification() {
    if (_muted) return;
    const c = ctx(); if (!c) return;
    const now = c.currentTime;
    _osc(880,  'sine', now,        0.28, 0.18);
    _osc(1108, 'sine', now + 0.16, 0.25, 0.14);
  }

  return {
    isMuted, setMuted, toggle, init,
    cardDeal, chipBet, potSlide,
    fold, check, call, raise, allIn,
    win, timerTick, newHand, notification
  };
})();
