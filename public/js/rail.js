'use strict';

requireAuth();
const user = getUser();
const params = new URLSearchParams(location.search);
const buyin = parseInt(params.get('buyin')) || 0;

document.getElementById('buyin-display').textContent = buyin
  ? `Requested buy-in: $${buyin.toLocaleString()}`
  : '';

// ─── Ambient music (Web Audio API) ────────────────────────────────────────

let audioCtx = null;
let musicPlaying = false;
let musicNodes = [];

function startMusic() {
  if (musicPlaying) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.12;
    masterGain.connect(audioCtx.destination);

    // Soft chord: root, major third, fifth, octave
    const freqs = [130.81, 164.81, 196.00, 261.63]; // C3 major chord
    freqs.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.3 / (i + 1);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start();
      musicNodes.push(osc, gain);

      // Subtle vibrato
      const lfo = audioCtx.createOscillator();
      const lfoGain = audioCtx.createGain();
      lfo.frequency.value = 0.2 + i * 0.05;
      lfoGain.gain.value = 0.5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start();
      musicNodes.push(lfo, lfoGain);
    });

    musicPlaying = true;
    document.getElementById('music-state').textContent = 'ON';
  } catch (e) {
    console.warn('Music error:', e);
  }
}

function stopMusic() {
  musicNodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch {} });
  musicNodes = [];
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  musicPlaying = false;
  document.getElementById('music-state').textContent = 'OFF';
}

function toggleMusic() {
  musicPlaying ? stopMusic() : startMusic();
}

// ─── Socket ────────────────────────────────────────────────────────────────

const socket = io({ auth: { token: getToken() } });

socket.on('connect', () => {
  socket.emit('rail:join', { buyin });
  document.getElementById('queue-status-text').textContent = 'Connected — waiting for admin to seat you…';
});

socket.on('rail:position', ({ position, total }) => {
  document.getElementById('position-num').textContent = position;
  document.getElementById('queue-status-text').textContent =
    `${total} player${total !== 1 ? 's' : ''} in queue. Admin will seat you soon.`;
});

socket.on('rail:approved', ({ amount, message }) => {
  stopMusic();
  document.getElementById('position-num').textContent = '✓';
  document.getElementById('queue-status-text').textContent = message;
  toast(message, 'success');
  setTimeout(() => window.location.href = '/lobby.html', 2500);
});

socket.on('rail:denied', ({ message }) => {
  stopMusic();
  document.getElementById('position-num').textContent = '✗';
  document.getElementById('queue-status-text').textContent = message;
  toast(message, 'error');
  setTimeout(() => window.location.href = '/lobby.html', 3000);
});

socket.on('connect_error', (err) => {
  document.getElementById('queue-status-text').textContent = 'Connection error: ' + err.message;
});

function leaveRail() {
  stopMusic();
  socket.emit('rail:leave');
  window.location.href = '/lobby.html';
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const toastContainer = document.getElementById('toast-container');
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
