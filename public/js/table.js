'use strict';

requireAuth();

const user = getUser();
const params = new URLSearchParams(location.search);
const tableId = params.get('tableId');
const buyIn = parseInt(params.get('buyIn')) || 200;
const spectateMode = params.get('spectate') === '1';

if (!tableId) window.location.href = '/lobby.html';
if (spectateMode && !user?.isAdmin) window.location.href = '/lobby.html';

let socket = null;
let gameState = null;
let myState = null;
let shotClockInterval = null;
let _reconnectTimer = null;
let _reconnectTapTimer = null;
let shotClockEnd = 0;
let chatOpen = false;
let prevBets = {};       // seatNumber -> last known currentBet
let seatTimerInterval = null;
let moneyPuck = null;    // current puck state for this table
let straddleCountdown = null;

// Hand history
let lastHandHistory = [];
let lastHandResult = null;
let currentRunoutCards = null; // hole cards to keep visible during all-in runout

// ─── Inbox state ────────────────────────────────────────────────────────────
const TABLE_INBOX_READ_KEY = 'rp_inbox_read_table';
let tableInboxMessages = [];

// Raise limits — updated each time it becomes the player's turn
let currentMaxRaise = 0;
let currentMinRaise = 0;

// ─── WebRTC PTT state ──────────────────────────────────────────────────────────
let micStream = null;           // MediaStream; track.enabled = true/false toggles PTT
let pttActive = false;
const pttPeers = new Map();     // peerId -> RTCPeerConnection
const pttAudioEls = new Map();  // peerId -> HTMLAudioElement
const pttPending = new Map();   // peerId -> RTCIceCandidate[] (buffered before remoteDesc set)
let adminMuted = false;        // true when admin has muted this client
let openMicMode = false;       // true when in continuous open-mic mode
let openMicActive = false;     // true when currently transmitting in open-mic mode

// ─── Waitlist state ───────────────────────────────────────────────────────
let _waitlistState = {}; // { active, position, total, seatAvailable }

// ─── Chat state ───────────────────────────────────────────────────────────
const CHAT_STORAGE_KEY = `rp_chat_${tableId}`;
let _chatHistory = [];
(function _restoreChatHistory() {
  try {
    const saved = sessionStorage.getItem(CHAT_STORAGE_KEY);
    if (saved) _chatHistory = JSON.parse(saved);
  } catch {}
})();

// ─── Table stats ──────────────────────────────────────────────────────────
let _tableStats = null;

// ─── Rabbit hunt state ────────────────────────────────────────────────────
let _rabbitAvailable = false;

// ─── Straddle prompt state ────────────────────────────────────────────────
let _straddlePromptEl = null;
let _straddleCountdown = null;
let _adminCamUserId = null; // userId of spectating admin with camera live

// ─── Camera state ─────────────────────────────────────────────────────────
let camStream = null;            // local camera MediaStream
let camEnabled = false;          // whether our camera is on
const peerCamStreams = new Map(); // userId -> MediaStream (remote video)
const peerCamEnabled = new Map(); // userId -> bool (remote cam state)

const ICE_CFG = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
] };

// ─── Chip denomination config ─────────────────────────────────────────────
const CHIP_DENOMS = [
  { value: 1000, bg: '#d4af37', border: '#a07820', text: '#1a1000' }, // Yellow
  { value: 500,  bg: '#7c3aed', border: '#4c1d95', text: '#ede9fe' }, // Purple
  { value: 100,  bg: '#1e293b', border: '#475569', text: '#cbd5e1' }, // Black
  { value: 25,   bg: '#15803d', border: '#14532d', text: '#bbf7d0' }, // Green
  { value: 10,   bg: '#1d4ed8', border: '#1e3a8a', text: '#bfdbfe' }, // Blue
  { value: 5,    bg: '#b91c1c', border: '#7f1d1d', text: '#fecaca' }, // Red
  { value: 1,    bg: '#e5e7eb', border: '#9ca3af', text: '#374151' }, // White
];

function chipStack(amount) {
  if (!amount || amount <= 0) return '<span style="color:var(--red);font-size:.75rem">0</span>';
  let rem = Math.floor(amount);
  const groups = [];
  for (const d of CHIP_DENOMS) {
    if (rem <= 0) break;
    const n = Math.floor(rem / d.value);
    if (n > 0) { groups.push({ ...d, count: n }); rem -= n * d.value; }
  }
  const dots = groups.slice(0, 5).map(g =>
    `<span class="chip-dot" style="background:${g.bg};border-color:${g.border}" title="${g.count}×$${g.value}">${g.count > 1 ? `<span class="chip-dot-n" style="color:${g.text}">${g.count > 9 ? '9+' : g.count}</span>` : ''}</span>`
  ).join('');
  const breakdown = groups.map(g =>
    `<div class="chip-breakdown-row"><span class="chip-breakdown-dot" style="background:${g.bg};border-color:${g.border}"></span><span class="chip-breakdown-label">${g.count}×$${g.value}</span><span class="chip-breakdown-value">$${fmt(g.count * g.value)}</span></div>`
  ).join('');
  return `<span class="chip-stack" style="position:relative">${dots}<span class="chip-total">${fmt(amount)}</span><span class="chip-breakdown">${breakdown}<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:4px;padding-top:4px;color:var(--chip-green);font-weight:700">Total: $${fmt(amount)}</div></span></span>`;
}

// ─── Seat Layout (positions as % of oval width/height offset from center) ──

const SEAT_POSITIONS = {
  2:  [{ x:50, y:85 }, { x:50, y:15 }],
  3:  [{ x:50, y:90 }, { x:15, y:20 }, { x:85, y:20 }],
  4:  [{ x:50, y:90 }, { x:5,  y:50 }, { x:50, y:10 }, { x:95, y:50 }],
  5:  [{ x:50, y:90 }, { x:10, y:65 }, { x:20, y:15 }, { x:80, y:15 }, { x:90, y:65 }],
  6:  [{ x:50, y:92 }, { x:8,  y:65 }, { x:8,  y:30 }, { x:50, y:8 }, { x:92, y:30 }, { x:92, y:65 }],
  7:  [{ x:50, y:92 }, { x:10, y:68 }, { x:5,  y:32 }, { x:25, y:8 }, { x:75, y:8 }, { x:95, y:32 }, { x:90, y:68 }],
  8:  [{ x:50, y:92 }, { x:12, y:72 }, { x:3,  y:42 }, { x:12, y:12 }, { x:50, y:5 }, { x:88, y:12 }, { x:97, y:42 }, { x:88, y:72 }],
  9:  [{ x:50, y:92 }, { x:15, y:75 }, { x:3,  y:50 }, { x:10, y:20 }, { x:35, y:5 }, { x:65, y:5 }, { x:90, y:20 }, { x:97, y:50 }, { x:85, y:75 }]
};

// ─── Orientation Lock ─────────────────────────────────────────────────────
// CSS rotation (style.css) handles portrait→landscape automatically.
// screen.orientation.lock is still attempted for Android PWA installs.
(function initOrientation() {
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }
})();

// Initialise sound engine (reads mute preference from localStorage)
if (window.Sound) Sound.init();

function toggleSoundThemePanel() {
  let panel = document.getElementById('sound-theme-panel');
  if (panel) { panel.remove(); return; }
  panel = document.createElement('div');
  panel.id = 'sound-theme-panel';
  panel.className = 'sound-theme-panel';
  const current = window.Sound ? Sound.getTheme() : 'classic';
  panel.innerHTML = `
    <div class="stp-title">Sound Theme</div>
    <button id="sfx-theme-classic" class="stp-btn${current === 'classic' ? ' active' : ''}" onclick="Sound.setTheme('classic');document.getElementById('sound-theme-panel')?.remove()">
      🎰 Classic Casino
    </button>
    <button id="sfx-theme-modern" class="stp-btn${current === 'modern' ? ' active' : ''}" onclick="Sound.setTheme('modern');document.getElementById('sound-theme-panel')?.remove()">
      🎧 Modern
    </button>
    <button id="sfx-theme-silent" class="stp-btn${current === 'silent' ? ' active' : ''}" onclick="Sound.setTheme('silent');document.getElementById('sound-theme-panel')?.remove()">
      🔕 Silent
    </button>`;
  const btn = document.getElementById('sound-toggle-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    panel.style.right  = (window.innerWidth - rect.right) + 'px';
  }
  document.body.appendChild(panel);
  setTimeout(() => document.addEventListener('click', function _close(e) {
    if (!document.getElementById('sound-theme-panel')?.contains(e.target)) {
      document.getElementById('sound-theme-panel')?.remove();
      document.removeEventListener('click', _close);
    }
  }, { capture: true }), 0);
}

// ─── Spectator / Observer Mode ────────────────────────────────────────────

function _enterSpectatorMode(tableName) {
  const banner = document.getElementById('spectator-banner');
  if (banner) {
    banner.style.display = 'flex';
    const nameEl = document.getElementById('spectator-table-name');
    if (nameEl) nameEl.textContent = tableName || 'Table';
  }
  const camBtn = document.getElementById('spectator-cam-btn');
  if (camBtn) camBtn.style.display = '';
  const recBtn = document.getElementById('rec-btn');
  if (recBtn) recBtn.style.display = '';
  const hlBtn = document.getElementById('highlight-btn');
  if (hlBtn) hlBtn.style.display = 'none'; // only shown during active recording
  // Hide player action UI — spectators can't act
  const actionArea = document.getElementById('action-area');
  if (actionArea) actionArea.style.display = 'none';
  const myCardsArea = document.getElementById('my-cards-area');
  if (myCardsArea) myCardsArea.style.display = 'none';
}

function exitSpectateMode() {
  socket?.emit('admin:leave_spectate', { tableId });
  window.close();
  setTimeout(() => { window.location.href = '/admin.html'; }, 300);
}

async function spectatorCamToggle() {
  if (camEnabled) {
    _camDisable();
  } else {
    await _camEnable();
  }
  const btn = document.getElementById('spectator-cam-btn');
  if (btn) btn.textContent = camEnabled ? '📷 Live' : '📷 Go Live';
}

function _checkAdminCamStream() {
  const overlay = document.getElementById('admin-cam-overlay');
  const overlayVid = document.getElementById('admin-cam-video');
  if (!overlay || !overlayVid) return;

  for (const [uid, stream] of peerCamStreams) {
    const avatarEl = document.querySelector(`.seat-avatar[data-cam-uid="${uid}"]`);
    if (avatarEl) continue; // has a seat — handled by normal flow
    const enabled = peerCamEnabled.get(uid);
    const hasLiveVideo = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
    if (enabled || hasLiveVideo) {
      if (overlayVid.srcObject !== stream) {
        overlayVid.srcObject = stream;
        overlayVid.play().catch(() => {});
      }
      overlay.style.display = 'block';
      return;
    }
  }
  // No unseat'd cam stream active
  if (!_adminCamUserId) overlay.style.display = 'none';
}

// ─── Screen Recording ─────────────────────────────────────────────────────────

let _mediaRecorder   = null;
let _recordingChunks = [];
let _recordingStart  = null;
let _recordingTimer  = null;
let _highlights      = [];  // { t (seconds), description, handNum }

async function startRecording() {
  if (_mediaRecorder) { stopRecording(); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    });
    _recordingChunks = [];
    _highlights      = [];
    _recordingStart  = Date.now();

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    _mediaRecorder = new MediaRecorder(stream, { mimeType });
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recordingChunks.push(e.data); };
    _mediaRecorder.onstop = _onRecordingStop;
    _mediaRecorder.start(1000);
    stream.getVideoTracks()[0].onended = stopRecording;

    _updateRecordingUI(true);
    toast('Recording started — share the browser tab');
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
      toast('Recording failed: ' + e.message, 'error');
    }
  }
}

function stopRecording() {
  if (!_mediaRecorder) return;
  _mediaRecorder.stream.getTracks().forEach(t => t.stop());
  _mediaRecorder.stop();
  _mediaRecorder = null;
  _updateRecordingUI(false);
}

function _onRecordingStop() {
  const blob = new Blob(_recordingChunks, { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);
  const ts   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rabbsroom-${ts}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (_highlights.length) _showHighlightsSummary();
}

function _updateRecordingUI(active) {
  const recBtn = document.getElementById('rec-btn');
  const hlBtn  = document.getElementById('highlight-btn');
  const recInd = document.getElementById('rec-indicator');

  if (recBtn) {
    recBtn.textContent = active ? '⏹ Stop' : '⏺ Record';
    recBtn.style.background    = active ? 'rgba(200,0,0,.3)' : 'rgba(200,0,0,.15)';
    recBtn.style.borderColor   = active ? '#ff4444' : 'rgba(255,60,60,.5)';
  }
  if (hlBtn) hlBtn.style.display = active ? '' : 'none';
  if (recInd) recInd.style.display = active ? 'flex' : 'none';

  if (active) {
    _recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - _recordingStart) / 1000);
      const m = Math.floor(elapsed / 60), s = elapsed % 60;
      const timerEl = document.getElementById('rec-timer');
      if (timerEl) timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
  } else {
    clearInterval(_recordingTimer);
    _recordingTimer = null;
  }
}

function saveHighlight() {
  if (!_mediaRecorder) { toast('Start recording first', 'error'); return; }
  const elapsed = Math.floor((Date.now() - _recordingStart) / 1000);
  const handNum = gameState?.handNumber || gameState?.currentHandNumber || '?';
  const desc = prompt('Describe this highlight (e.g. "Bad Beat — lost with full house"):',
    `Hand #${handNum}`);
  if (desc == null) return;
  const m = Math.floor(elapsed / 60), s = elapsed % 60;
  _highlights.push({ t: elapsed, description: desc.trim() || `Hand #${handNum}`, handNum });
  toast(`Highlight saved at ${m}:${String(s).padStart(2, '0')}`);
}

function _showHighlightsSummary() {
  if (!_highlights.length) return;
  const rows = _highlights.map(h => {
    const m = Math.floor(h.t / 60), s = h.t % 60;
    return `<tr><td style="padding:4px 8px;color:var(--gold)">${m}:${String(s).padStart(2, '0')}</td><td style="padding:4px 8px">${_escHl(h.description)}</td></tr>`;
  }).join('');
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9990;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:12px;padding:24px;max-width:480px;width:92%;max-height:80vh;overflow-y:auto">
      <h3 style="color:var(--gold);margin-bottom:12px">📎 ${_highlights.length} Highlight${_highlights.length > 1 ? 's' : ''} Saved</h3>
      <p style="color:var(--text-dim);font-size:.82rem;margin-bottom:12px">These timestamps are in your downloaded .webm file. Upload it to the Highlights page to share.</p>
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">${rows}</table>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button onclick="window.open('/highlights.html','_blank')" style="background:none;border:1px solid var(--gold);color:var(--gold);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:.82rem">Open Highlights Page</button>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:.82rem">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _escHl(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ─── Connect ──────────────────────────────────────────────────────────────

function manualReconnect() {
  if (socket) {
    socket.connect();
  } else {
    connect();
  }
}

function connect() {
  socket = io({
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
    auth: { token: getToken() }
  });
  window.tableSocket = socket; // expose globally for inline scripts

  socket.on('connect', () => {
    console.log('[socket] connected, socketId:', socket.id);
    clearTimeout(_reconnectTapTimer);
    clearTimeout(_reconnectTimer);
    // Hide banner after brief delay so user sees it restored
    _reconnectTimer = setTimeout(() => {
      document.getElementById('reconnecting-banner').style.display = 'none';
    }, 500);
    if (spectateMode) {
      socket.emit('admin:spectate', { tableId });
      checkMicPermission();
    } else {
      socket.emit('join_table', { tableId, buyInChips: buyIn });
      checkMicPermission();
      renderHostControls();
    }
  });

  socket.on('connect_error', (err) => {
    // Only toast on first error — banner handles the ongoing reconnect state
    if (document.getElementById('reconnecting-banner')?.style.display !== 'block') {
      toast(`Connection error: ${err.message}`, 'error');
    }
  });

  socket.on('joined_table', ({ seatNumber, chips, tableName, feltColor }) => {
    toast(`Joined seat ${seatNumber} with ${fmt(chips)} chips`);
    document.getElementById('hdr-chips').textContent = fmt(chips);
    if (tableName) document.getElementById('hdr-table-name').textContent = tableName;
    if (feltColor) applyFeltColor(feltColor);
    // Show High Hand submit button for hosts and admins
    if (user?.isHost || user?.isAdmin) {
      const hhBtn = document.getElementById('host-hh-btn');
      if (hhBtn) hhBtn.style.display = '';
    }
    _pttInit();
    _showCamPrompt();
    // Request current table stats
    socket.emit('table:get_stats', { tableId });
    // Restore chat history
    _chatHistory.forEach(m => chatMsg(m.name, m.text, m.type));
  });

  socket.on('game_state', (state) => {
    console.log('[game_state] hand:', state.handActive, 'street:', state.currentStreet, 'players:', state.players?.length, 'seat:', state.currentPlayerSeat, 'pot:', state.pot);
    // Detect new bets for chip animation before re-render
    if (state.players) {
      for (const p of state.players) {
        const prev = prevBets[p.seatNumber] || 0;
        if (p.currentBet > prev && !p.hasFolded) {
          animateChipToPot(p.seatNumber, p.currentBet - prev);
        }
        prevBets[p.seatNumber] = p.currentBet;
      }
    }
    gameState = state;
    renderTable(state);
    updateHeader(state);
    // Re-apply revealed cards during all-in runout (game_state shows ? face-down)
    if (currentRunoutCards) _revealAllSeatsCards(currentRunoutCards);
    // Keep header chip count in sync with table stack
    const me = state.players?.find(p => p.userId === user.id);
    if (me != null) {
      document.getElementById('hdr-chips').textContent = fmt(me.chips);
    }
    // Pause banner
    _updatePauseBanner(state.isPaused, state.pauseReason);
  });

  socket.on('my_state', (state) => {
    myState = state;
    renderMyCards(state);
    updateActionButtons(state);
  });

  socket.on('hand_started', ({ handNumber, dealerSeat }) => {
    console.log('[hand_started] hand:', handNumber, 'dealer seat:', dealerSeat);
    if (window.DealerVoice) DealerVoice.onHandStarted({ handNumber, dealerSeat }, gameState);
    _clearShowdownHighlights();
    currentRunoutCards = null;
    if (window.Sound) Sound.newHand();
    chatMsg('system', `Hand #${handNumber} started`);
    hideHandResult();
    const myCards = document.getElementById('my-hole-cards');
    if (myCards) myCards.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem;align-self:center">Dealing…</div>';
  });

  socket.on('cards_dealt', ({ holeCards }) => {
    console.log('[cards_dealt]', holeCards?.map(c => c.rank + c.suit).join(' ') || 'none');
    if (window.Sound) Sound.cardDeal();
    renderMyHoleCards(holeCards);
  });

  socket.on('action_required', ({ seatNumber, userId: actingUserId, callAmount, pot }) => {
    console.log('[action_required] seat:', seatNumber, 'userId:', actingUserId, 'callAmt:', callAmount);
    if (window.DealerVoice) DealerVoice.onActionRequired({ seatNumber }, gameState);
    const isMe = actingUserId === user.id;
    if (isMe) {
      toast('Your turn!');
      if (window.Sound) Sound.notification();
    }
  });

  socket.on('player_acted', ({ action, amount, username: actorName, isAllIn }) => {
    if (window.DealerVoice) DealerVoice.onPlayerActed({ action, username: actorName, isAllIn });
    if (!window.Sound) return;
    if (isAllIn) { Sound.allIn(); return; }
    switch (action) {
      case 'fold':  Sound.fold();          break;
      case 'check': Sound.check();         break;
      case 'call':  Sound.call();          break;
      case 'raise': Sound.raise(amount);   break;
      default:      Sound.chipBet(amount); break;
    }
  });

  socket.on('shot_clock_start', ({ userId, seconds, seatNumber }) => {
    if (userId === user.id) startShotClock(seconds);
    startSeatTimer(seatNumber, seconds);
  });

  socket.on('shot_clock_warning', ({ secondsLeft }) => {
    document.querySelector('.shot-clock-fill')?.classList.add('warning');
    toast(`${secondsLeft} seconds left!`, 'error');
  });

  socket.on('street_changed', ({ street, communityCards, allInRunout, allHoleCards }) => {
    console.log('[street_changed]', street, '|', communityCards?.map(c => c.rank + c.suit).join(' '), allInRunout ? '(all-in runout)' : '');
    if (window.DealerVoice) DealerVoice.onStreetChanged({ street });
    if (gameState) {
      gameState.currentStreet = street;
      gameState.communityCards = communityCards;
    }
    renderCommunityCards(communityCards);
    document.getElementById('hdr-street').textContent = street.toUpperCase();
    chatMsg('system', `--- ${street.toUpperCase()}${allInRunout ? ' (All-In)' : ''} ---`);
    if (allInRunout && allHoleCards) {
      currentRunoutCards = allHoleCards;
      _revealAllSeatsCards(allHoleCards);
    }
  });

  socket.on('you:host_granted', ({ message }) => {
    toast('🎰 ' + message);
    const u = getUser();
    if (u) { u.isHost = true; sessionStorage.setItem('rp_user', JSON.stringify(u)); }
    renderHostControls();
  });

  socket.on('you:host_revoked', ({ message }) => {
    toast(message);
    const u = getUser();
    if (u) { u.isHost = false; sessionStorage.setItem('rp_user', JSON.stringify(u)); }
    renderHostControls();
  });

  socket.on('chips_added', ({ targetUserId, amount, by }) => {
    toast(`✅ +${fmt(amount)} chips added to player`);
  });

  socket.on('chips_received', ({ amount, from }) => {
    toast(`🪙 +${fmt(amount)} chips added by ${from}`);
    document.getElementById('hdr-chips').textContent = fmt((parseInt(document.getElementById('hdr-chips').textContent.replace(/,/g,'')) || 0) + amount);
  });

  socket.on('hand_ended', (result) => {
    console.log('[hand_ended] winners:', result.winners?.map(w => w.username), 'folded:', result.folded, 'rake:', result.rakeCollected);
    if (window.DealerVoice) DealerVoice.onHandEnded(result);
    stopShotClock();
    clearSeatTimer();
    prevBets = {};
    currentRunoutCards = null; // clear runout overlay
    lastHandHistory = result.history || [];
    lastHandResult = result;
    _rabbitAvailable = false;
    _hideRabbitButton();
    // Reveal all hole cards at showdown
    if (result.allHoleCards) _revealAllSeatsCards(result.allHoleCards);
    if (result.allHoleCards && !result.folded) _highlightWinners(result.winners);
    if (window.Sound) {
      Sound.potSlide();
      const iWon = result.winners?.some(w => w.userId === user.id);
      if (iWon) setTimeout(() => Sound.win(), 450);
    }

    // Flash rake deduction in pot display before showing winner overlay
    if (result.rakeCollected > 0) {
      const potEl = document.getElementById('pot-amount');
      const potLabel = potEl?.nextElementSibling; // .pot-label
      if (potEl) {
        potEl.textContent = `Rake: $${fmt(result.rakeCollected)}`;
        potEl.style.color = 'var(--red)';
        potEl.style.fontSize = '1rem';
        if (potLabel) potLabel.textContent = '🏦 DEDUCTED';
        setTimeout(() => {
          potEl.style.color = '';
          potEl.style.fontSize = '';
          if (potLabel) potLabel.textContent = 'POT';
          showHandResult(result);
        }, 1500);
      } else {
        showHandResult(result);
      }
    } else {
      showHandResult(result);
    }

    if (result.winners?.length) {
      if (result.isSplitPot) {
        const names = result.winners.map(w => `${w.username} +$${fmt(w.amount)}`).join(', ');
        chatMsg('system', `🤝 Split Pot: ${names}${result.rakeCollected ? ` | Rake: $${fmt(result.rakeCollected)}` : ''}`);
      } else {
        chatMsg('system', `Winner: ${result.winners[0].username} (${result.winners[0].handName || 'folded out'}) +${fmt(result.winners[0].amount)}${result.rakeCollected ? ` | Rake: $${fmt(result.rakeCollected)}` : ''}`);
      }
    }
  });

  socket.on('cashout_confirmed', ({ chips }) => {
    toast(`✅ Cashed out ${fmt(chips)} chips. Returning to lobby…`);
    setTimeout(() => window.location.href = '/lobby.html', 1500);
  });

  // ─── Money Puck ───────────────────────────────────────────────────────────

  socket.on('puck:state', (state) => {
    moneyPuck = state?.holderId ? state : null;
    if (gameState) { renderSeats(gameState); renderHostControls(gameState); }
  });

  socket.on('puck:straddle_required', ({ value, deadline }) => {
    showStraddlePrompt(value, deadline);
  });

  socket.on('game_paused', ({ reason, by }) => {
    _updatePauseBanner(true, reason);
    toast(`⏸ Game paused by ${by}${reason ? `: "${reason}"` : ''}`, 'warn');
  });

  socket.on('game_resumed', ({ by }) => {
    _updatePauseBanner(false, null);
    toast(`▶️ Game resumed by ${by}`);
  });

  socket.on('jackpot_state', (data) => {
    updateJackpotDisplay(data);
  });

  socket.on('jackpot_won', ({ amount, message }) => {
    toast(`🏆 ${message}`, 'jackpot');
  });

  socket.on('jackpot_awarded', ({ amount, winnerId }) => {
    if (winnerId) chatMsg('system', `🏆 JACKPOT AWARDED: $${amount}`);
  });

  socket.on('blind_increase', ({ blindLevel, small_blind, big_blind, timerState }) => {
    toast(`🔼 Blinds Level ${blindLevel}: $${small_blind}/$${big_blind}`);
    chatMsg('system', `Blinds increased to $${small_blind}/$${big_blind} (Level ${blindLevel})`);
    if (window.Sound) Sound.notification();
    if (timerState) updateBlindTimer(timerState);
  });

  socket.on('blind_warning', ({ nextLevel, nextSmallBlind, nextBigBlind, secondsUntil }) => {
    toast(`⚠️ Blinds increase in ${secondsUntil}s → Level ${nextLevel}: $${nextSmallBlind}/$${nextBigBlind}`, 'warn');
    if (window.Sound) Sound.notification();
  });

  socket.on('tournament_started', ({ timerState }) => {
    if (timerState) updateBlindTimer(timerState);
  });

  socket.on('tournament_timer', (timerState) => {
    updateBlindTimer(timerState);
  });

  socket.on('tournament_timer_paused', ({ timerState }) => {
    updateBlindTimer(timerState);
  });

  socket.on('tournament_timer_resumed', ({ timerState }) => {
    updateBlindTimer(timerState);
  });

  socket.on('chat', ({ username: chatUser, message }) => {
    if (message && message.startsWith('__sticker__:')) {
      chatMsg(chatUser, message.replace('__sticker__:', ''), 'sticker');
    } else {
      chatMsg(chatUser, message);
    }
  });

  socket.on('break_granted', ({ breakPassesRemaining }) => {
    toast(`On break. ${breakPassesRemaining} passes remaining`);
    document.getElementById('btn-break').textContent = `☕ Break (${breakPassesRemaining})`;
  });

  socket.on('kicked', ({ message }) => {
    toast(message, 'error');
    setTimeout(() => window.location.href = '/lobby.html', 2000);
  });

  socket.on('broadcast_message', (data) => {
    console.log('[table] broadcast_message received:', data);
    if (!tableInboxMessages.find(m => m.id === data.id)) tableInboxMessages.unshift(data);
    updateTableInboxBadge();
    showAdminMessageToast(data.from, data.message, data.pending, data.id);
  });
  socket.on('broadcast:message', (data) => {
    console.log('[table] broadcast:message (legacy) received:', data);
    if (!tableInboxMessages.find(m => m.id === data.id)) tableInboxMessages.unshift(data);
    updateTableInboxBadge();
    showAdminMessageToast(data.from, data.message, data.pending, data.id);
  });

  socket.on('banned', ({ message }) => {
    clearAuth();
    toast('Your account has been suspended.', 'error');
    setTimeout(() => window.location.href = '/index.html', 2500);
  });

  socket.on('table_closed', () => {
    toast('Table closed by admin', 'error');
    setTimeout(() => window.location.href = '/lobby.html', 2000);
  });

  socket.on('error', ({ message }) => {
    toast(message, 'error');
    if (message === 'No open seats') {
      _showWaitlistOffer();
    }
  });

  // ─── Waitlist ────────────────────────────────────────────────────────────

  socket.on('waitlist:joined', ({ position, total }) => {
    _waitlistState = { position, total, active: true };
    _updateWaitlistBanner();
  });

  socket.on('waitlist:position', ({ position, total }) => {
    if (!_waitlistState?.active) return;
    _waitlistState = { position, total, active: true };
    _updateWaitlistBanner();
  });

  socket.on('waitlist:seat_available', ({ tableName, message: msg }) => {
    _waitlistState.seatAvailable = true;
    const banner = document.getElementById('waitlist-banner');
    const msgEl  = document.getElementById('waitlist-banner-msg');
    const joinBtn = document.getElementById('waitlist-join-btn');
    if (banner) banner.style.display = '';
    if (msgEl)  msgEl.textContent = msg || `A seat opened at ${tableName}!`;
    if (joinBtn) joinBtn.style.display = '';
    if (window.Sound) Sound.notification();
    toast('A seat opened — you\'re next on the waiting list!', 'success');
  });

  socket.on('waitlist:left',    () => { _waitlistState = {}; _updateWaitlistBanner(); });
  socket.on('waitlist:removed', ({ reason }) => {
    _waitlistState = {};
    _updateWaitlistBanner();
    toast(reason || 'Removed from waitlist', 'error');
  });

  // ─── Chat extras ───────────────────────────────────────────────────────
  socket.on('chat:cleared', ({ by }) => {
    const el = document.getElementById('chat-messages');
    if (el) el.innerHTML = '';
    _chatHistory = [];
    try { sessionStorage.removeItem(CHAT_STORAGE_KEY); } catch {}
    chatMsg('system', `🧹 Chat cleared by ${by}`);
  });

  socket.on('chat_reaction', ({ username: reactorName, emoji }) => {
    _showReactionFloat(reactorName, emoji);
  });

  // ─── Table stats ───────────────────────────────────────────────────────
  socket.on('table:stats', (stats) => {
    _tableStats = stats;
    _renderTableStats();
  });

  // ─── Rabbit hunt ───────────────────────────────────────────────────────
  socket.on('rabbit:available', () => {
    _rabbitAvailable = true;
    const u = getUser();
    if (u?.isHost || u?.isAdmin) _showRabbitButton();
  });

  socket.on('rabbit:result', (data) => {
    _rabbitAvailable = false;
    _showRabbitResult(data);
    _hideRabbitButton();
  });

  // ─── Straddle ──────────────────────────────────────────────────────────
  socket.on('straddle_offer', ({ amount, deadline }) => {
    _showStraddleOffer(amount, deadline);
  });

  socket.on('disconnect', (reason) => {
    const banner = document.getElementById('reconnecting-banner');
    const status = document.getElementById('reconnect-status');
    const tapBtn = document.getElementById('reconnect-tap-btn');
    if (banner) banner.style.display = 'block';
    if (tapBtn) tapBtn.style.display = 'none';
    if (status) status.textContent = '⚠️ Connection lost — reconnecting…';
    // Show tap-to-reconnect button after 10s
    _reconnectTapTimer = setTimeout(() => {
      if (tapBtn) tapBtn.style.display = '';
      if (status) status.textContent = '⚠️ Connection lost —';
    }, 10000);
  });

  // ─── WebRTC PTT ─────────────────────────────────────────────────────────

  // Server sends list of existing peers at table → we are the offerer to each
  socket.on('ptt:mesh_peers', async ({ peers }) => {
    console.log('[PTT] mesh_peers:', peers.map(p => p.username));
    for (const peer of peers) {
      await _pttOffer(peer.userId);
    }
  });

  // New peer joined → they will send us an offer; nothing to do
  socket.on('ptt:new_peer', ({ userId: pid, username: pname }) => {
    console.log('[PTT] new peer:', pname, '— waiting for offer');
  });

  // WebRTC signaling relay: offer / answer / ICE
  socket.on('ptt:signal', async ({ fromUserId, signal }) => {
    if (signal.type === 'offer') {
      await _pttAnswer(fromUserId, signal.sdp);

    } else if (signal.type === 'answer') {
      const pc = pttPeers.get(fromUserId);
      if (!pc || pc.signalingState !== 'have-local-offer') return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        for (const c of (pttPending.get(fromUserId) || [])) {
          try { await pc.addIceCandidate(c); } catch {}
        }
        pttPending.set(fromUserId, []);
        console.log('[PTT] answer accepted from', fromUserId);
      } catch (err) { console.warn('[PTT] answer error from', fromUserId, ':', err.message); }

    } else if (signal.type === 'ice') {
      const pc = pttPeers.get(fromUserId);
      let candidate;
      try { candidate = new RTCIceCandidate(signal.candidate); } catch { return; }
      if (pc?.remoteDescription?.type) {
        try { await pc.addIceCandidate(candidate); } catch {}
      } else {
        if (!pttPending.has(fromUserId)) pttPending.set(fromUserId, []);
        pttPending.get(fromUserId).push(candidate);
      }
    }
  });

  // Speaking indicators
  socket.on('ptt:speaker_active', ({ userId: sid, username: sname }) => setSpeakingIndicator(sid, true, sname));
  socket.on('ptt:speaker_stopped', ({ userId: sid }) => setSpeakingIndicator(sid, false));

  // Admin muted this player
  socket.on('ptt:muted_by_admin', ({ message }) => {
    adminMuted = true;
    if (pttActive) stopPTT();
    _stopOpenMic();
    const btn = document.getElementById('ptt-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; btn.title = 'Muted by admin'; }
    toast(message || 'Your mic has been muted by admin', 'error');
    socket.emit('ptt:mic_status', { status: 'muted' });
  });

  // Admin unmuted this player
  socket.on('ptt:unmuted_by_admin', () => {
    adminMuted = false;
    const btn = document.getElementById('ptt-btn');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.title = micStream ? 'Mic ready — hold to talk' : ''; }
    toast('Your mic has been unmuted');
    socket.emit('ptt:mic_status', { status: 'idle' });
    if (openMicMode) _startOpenMic();
  });

  // Audio mode changed by admin (PTT ↔ Open Mic)
  socket.on('ptt:mode_change', ({ mode }) => {
    openMicMode = (mode === 'openmic');
    const btn = document.getElementById('ptt-btn');
    if (openMicMode) {
      if (btn) { btn.textContent = '🎙 Open Mic (on)'; btn.style.cursor = 'default'; btn.onmousedown = null; btn.onmouseup = null; btn.ontouchstart = null; btn.ontouchend = null; }
      if (!adminMuted) _startOpenMic();
    } else {
      _stopOpenMic();
      if (btn) { btn.textContent = '🎙 Hold to Talk'; btn.style.cursor = ''; btn.onmousedown = (e) => startPTT(e); btn.onmouseup = () => stopPTT(); btn.ontouchstart = (e) => startPTT(e); btn.ontouchend = () => stopPTT(); }
    }
    renderAdminPttPanel();
  });

  // Admin PTT state broadcast (admin-only)
  socket.on('ptt:admin_state', ({ players, mode }) => {
    openMicMode = (mode === 'openmic');
    renderAdminPttPanel(players, mode);
  });

  // ─── Camera socket events ─────────────────────────────────────────────────

  socket.on('cam:state_change', ({ userId: uid, username: uname, enabled }) => {
    peerCamEnabled.set(uid, enabled);
    if (!enabled) {
      // Peer turned off cam — clear their avatar video
      const avatarEl = document.querySelector(`.seat-avatar[data-cam-uid="${uid}"]`);
      if (avatarEl) _clearAvatarVideo(avatarEl);
    } else {
      _updateSeatVideos();
    }
  });

  socket.on('cam:disabled_by_admin', () => {
    if (camEnabled) _camDisable();
    toast('Your camera has been disabled by admin', 'error');
  });

  // ─── Spectator socket events ──────────────────────────────────────────────

  socket.on('spectator_joined', ({ tableName, feltColor }) => {
    if (tableName) document.getElementById('hdr-table-name').textContent = tableName;
    if (feltColor) applyFeltColor(feltColor);
    _enterSpectatorMode(tableName);
    _pttInit();
    _showCamPrompt();
    socket.emit('table:get_stats', { tableId });
  });

  socket.on('spectator_state', (state) => {
    gameState = state;
    renderTable(state);
    updateHeader(state);
  });

  socket.on('admin:cam_presence', ({ userId: adminId, username: adminName, enabled }) => {
    if (enabled) {
      _adminCamUserId = adminId;
      const lbl = document.getElementById('admin-cam-label');
      if (lbl) lbl.textContent = `🎰 ${adminName}`;
    } else {
      if (_adminCamUserId === adminId) {
        _adminCamUserId = null;
        const overlay = document.getElementById('admin-cam-overlay');
        if (overlay) overlay.style.display = 'none';
      }
    }
    _updateSeatVideos();
  });
}

// ─── Render Table ─────────────────────────────────────────────────────────

function renderTable(state) {
  renderCommunityCards(state.communityCards || []);
  document.getElementById('pot-amount').textContent = `$${fmt(state.pot || 0)}`;
  renderSeats(state);
  renderHostControls(state);
}

function renderHostControls(state) {
  const panel = document.getElementById('host-controls');
  if (!panel) return;
  const u = getUser();
  if (!u?.isHost && !u?.isAdmin) { panel.style.display = 'none'; return; }
  const src = state || gameState;
  if (!src) return;

  const allPlayers = src.players || [];
  if (!allPlayers.length) {
    panel.style.display = 'none';
    const micPanel = document.getElementById('mic-controls-panel');
    if (micPanel) micPanel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  // Initialise collapse state once when panel first appears
  if (!panel.dataset.initialized) {
    panel.dataset.initialized = '1';
    const saved = localStorage.getItem('rp_host_panel_collapsed');
    const defaultCollapsed = window.innerWidth <= 768;
    const shouldCollapse = saved !== null ? saved === '1' : defaultCollapsed;
    panel.classList.toggle('collapsed', shouldCollapse);
    const btn = panel.querySelector('.host-collapse-btn');
    if (btn) btn.textContent = shouldCollapse ? '+' : '−';
  }

  const others = allPlayers.filter(p => p.userId !== user.id);

  const src2 = src;
  const isPaused = src2?.isPaused || false;

  // Player chip controls + pause + money puck + table options
  document.getElementById('host-player-list').innerHTML = others.map(p => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.07)">
      <span style="color:var(--text)">${esc(p.username)}</span>
      <span style="color:var(--chip-green);font-size:.7rem">${fmt(p.chips)}</span>
      <button class="btn btn-sm btn-gold" style="padding:2px 7px;font-size:.7rem" onclick="hostAddChips('${p.userId}','${esc(p.username)}')">+Chips</button>
      <button class="btn btn-sm btn-outline" style="padding:2px 7px;font-size:.7rem;color:var(--red)" onclick="hostCashOutPlayer('${p.userId}','${esc(p.username)}')">Cash Out</button>
    </div>`).join('') +
    // Pause / Resume control
    `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)">
      <div style="color:var(--gold);font-size:.72rem;font-weight:700;margin-bottom:5px">⏸ GAME CONTROL</div>
      ${isPaused
        ? `<div style="color:#facc15;font-size:.7rem;margin-bottom:4px">Paused${src2.pauseReason ? `: "${esc(src2.pauseReason)}"` : ''}</div>
           <button class="btn btn-sm btn-gold" style="font-size:.68rem;padding:3px 8px;width:100%" onclick="hostResumeGame()">▶️ Resume Game</button>`
        : `<div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px;color:var(--gold)" onclick="hostPauseGame('')">⏸ Pause</button>
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="hostPauseGame('Short break')">☕ Break</button>
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="hostPauseGame('Waiting for players')">⏳ Waiting</button>
           </div>`
      }
    </div>` +
    // Money puck controls
    `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)">
      <div style="color:var(--gold);font-size:.72rem;font-weight:700;margin-bottom:6px">💰 MONEY PUCK${moneyPuck ? ` — $${fmt(moneyPuck.value)} held by ${esc(moneyPuck.holderName)}` : ' — inactive'}</div>
      ${!moneyPuck
        ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn btn-sm btn-gold" style="font-size:.68rem;padding:3px 7px" onclick="dropPuck(0)">Drop Puck</button>
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="dropPuck(5)">Auto 5m</button>
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="dropPuck(10)">Auto 10m</button>
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="dropPuck(30)">Auto 30m</button>
           </div>`
        : `<div style="display:flex;gap:4px">
            <button class="btn btn-sm btn-outline" style="font-size:.68rem;padding:3px 7px" onclick="passPuck()">Pass</button>
            <button class="btn btn-sm btn-red" style="font-size:.68rem;padding:3px 7px" onclick="clearPuck()">Remove</button>
           </div>`
      }
    </div>` +
    // Table options: straddle, rabbit hunt, clear chat
    `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)">
      <div style="color:var(--gold);font-size:.72rem;font-weight:700;margin-bottom:5px">⚙️ TABLE OPTIONS</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        <button class="btn btn-sm btn-outline" style="font-size:.66rem;padding:2px 6px" onclick="hostToggleStraddle(${!src2?.straddleEnabled})">
          🎯 Straddle: ${src2?.straddleEnabled ? 'ON' : 'OFF'}
        </button>
        <button class="btn btn-sm btn-outline" style="font-size:.66rem;padding:2px 6px" onclick="hostToggleRabbit(${!src2?.rabbitHuntEnabled})">
          🐇 Rabbit: ${src2?.rabbitHuntEnabled ? 'ON' : 'OFF'}
        </button>
        ${u?.isAdmin ? `<button class="btn btn-sm btn-outline" style="font-size:.66rem;padding:2px 6px;color:var(--red)" onclick="clearChat()">🧹 Clear Chat</button>` : ''}
      </div>
    </div>`;

  // Admin Mic Controls (dedicated panel, top-left)
  if (u?.isAdmin) renderAdminPttPanel(allPlayers);
}

function hostAddChips(targetUserId, username) {
  const amt = parseInt(prompt(`Add chips for ${username}:`, '500'));
  if (!amt || amt <= 0) return;
  socket.emit('host:add_chips', { targetUserId, amount: amt });
}

function hostPauseGame(preset) {
  let reason = preset;
  if (reason === '') {
    const r = prompt('Pause reason (optional):', '');
    if (r === null) return; // cancelled
    reason = r.trim();
  }
  socket.emit('host:pause_game', { tableId, reason: reason || null });
}

function hostResumeGame() {
  socket.emit('host:resume_game', { tableId });
}

function hostCashOutPlayer(targetUserId, targetUsername) {
  if (!confirm(`Cash out ${targetUsername} from this table?`)) return;
  socket.emit('admin_action', { action: 'kick', tableId, targetUserId });
}

function dropPuck(autoDropMinutes) {
  socket.emit('puck:drop', { tableId, startValue: 15, autoDropMinutes });
}

function passPuck() {
  socket.emit('puck:pass', { tableId });
}

function clearPuck() {
  if (!confirm('Remove the money puck from the table?')) return;
  socket.emit('puck:clear', { tableId });
}

let straddlePromptEl = null;

function showStraddlePrompt(value, deadline) {
  dismissStraddlePrompt();

  const el = document.createElement('div');
  el.className = 'straddle-prompt';
  el.id = 'straddle-prompt';
  el.innerHTML = `
    <h4>💰 Money Puck — Straddle Required</h4>
    <p>Dealer button is yours. Post $${fmt(value)} straddle?</p>
    <div class="countdown" id="straddle-cd">15</div>
    <div class="btn-row">
      <button class="btn btn-gold" onclick="respondStraddle(true)">Post Straddle ($${fmt(value)})</button>
      <button class="btn btn-outline" onclick="respondStraddle(false)">Pass Puck</button>
    </div>`;
  document.body.appendChild(el);
  straddlePromptEl = el;

  const endTime = deadline;
  straddleCountdown = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const cd = document.getElementById('straddle-cd');
    if (cd) cd.textContent = remaining;
    if (remaining <= 0) {
      dismissStraddlePrompt();
      socket.emit('puck:straddle_response', { tableId, accepted: false });
    }
  }, 500);
}

function dismissStraddlePrompt() {
  if (straddleCountdown) { clearInterval(straddleCountdown); straddleCountdown = null; }
  if (straddlePromptEl) { straddlePromptEl.remove(); straddlePromptEl = null; }
  const existing = document.getElementById('straddle-prompt');
  if (existing) existing.remove();
}

function respondStraddle(accepted) {
  dismissStraddlePrompt();
  socket.emit('puck:straddle_response', { tableId, accepted });
}

function renderCommunityCards(cards) {
  const el = document.getElementById('community-cards');
  if (!cards || !cards.length) {
    el.innerHTML = Array(5).fill('<div class="card placeholder"></div>').join('');
    return;
  }
  const placeholders = Math.max(0, 5 - cards.length);
  el.innerHTML =
    cards.map(c => cardHtml(c, true)).join('') +
    Array(placeholders).fill('<div class="card placeholder"></div>').join('');
}

function _seatAvatarHtml(player) {
  if (player.avatarUrl) {
    return `<img class="seat-avatar-photo" src="${esc(player.avatarUrl)}" alt="${esc(player.username)}" loading="lazy">`;
  }
  if (player.isAdmin || player.isHost) {
    return `<img class="seat-rabbit-logo" src="/images/logo.svg" alt="host">`;
  }
  return `<div class="seat-initials">${esc(player.username).charAt(0).toUpperCase()}</div>`;
}

function renderSeats(state) {
  const container = document.getElementById('seats-container');
  const oval = document.getElementById('poker-oval');
  const maxPlayers = state.players?.length
    ? Math.max(state.players.length, (gameState?.maxPlayers || 9))
    : 9;

  const positions = SEAT_POSITIONS[Math.min(maxPlayers, 9)] || SEAT_POSITIONS[9];
  const ovalRect = oval.getBoundingClientRect();
  const wrapRect = oval.parentElement.getBoundingClientRect();

  // Build a map of seatNumber -> player
  const seatMap = {};
  (state.players || []).forEach(p => { seatMap[p.seatNumber] = p; });

  let html = '';
  for (let i = 0; i < positions.length; i++) {
    const seatNum = i + 1;
    const pos = positions[i];
    const player = seatMap[seatNum];
    const isDealer = state.dealerSeat === seatNum;
    const isActive = state.currentPlayerSeat === seatNum && state.handActive;

    if (player) {
      const isMe = player.userId === user.id;
      const hasPuck = moneyPuck?.holderSeat === seatNum;
      const isStraddler = state.straddlePlayerSeat === seatNum;
      const holeCardsHtml = player.holeCards?.length
        ? player.holeCards.map(c => c.rank === '?' ? '<div class="card back"></div>' : cardHtml(c)).join('')
        : '';

      html += `
        <div class="seat" data-seat="${seatNum}" style="left:${pos.x}%;top:${pos.y}%">
          <div class="seat-box ${isActive ? 'active-player' : ''} ${player.hasFolded ? 'folded' : ''} ${player.isSittingOut ? 'sitting-out' : ''} ${isMe ? 'me' : ''}" data-user-id="${player.userId}">
            ${isDealer ? '<div class="dealer-puck">D</div>' : ''}
            ${hasPuck ? `<div class="money-puck">💰 $${fmt(moneyPuck.value)}</div>` : ''}
            ${isStraddler ? `<div class="straddle-badge">STR $${fmt(state.bigBlind * 2)}</div>` : ''}
            <div class="seat-avatar" data-cam-uid="${player.userId}">${_seatAvatarHtml(player)}</div>
            <div class="seat-name" title="${esc(player.username)}">${esc(player.username.length > 10 ? player.username.slice(0,10) + '…' : player.username)}${isMe ? ' (You)' : ''}</div>
            <div class="seat-chips">${player.chips > 0 ? chipStack(player.chips) : '<span style="color:var(--red);font-size:.7rem">0 – Rebuy?</span>'}</div>
            ${player.currentBet ? `<div class="seat-bet">+$${fmt(player.currentBet)}</div>` : ''}
            ${holeCardsHtml ? `<div class="seat-cards">${holeCardsHtml}</div>` : ''}
            ${player.isSittingOut ? '<div style="color:#888;font-size:.65rem">away</div>' : ''}
            ${player.isAllIn ? '<div style="color:var(--red);font-size:.65rem;font-weight:bold">ALL IN</div>' : ''}
          </div>
        </div>`;
    } else {
      html += `
        <div class="seat" data-seat="${seatNum}" style="left:${pos.x}%;top:${pos.y}%">
          <div class="seat-box empty" onclick="takeSeat(${seatNum})">
            <div style="font-size:.75rem">Seat ${seatNum}</div>
            <div style="font-size:.7rem">Click to sit</div>
          </div>
        </div>`;
    }
  }

  container.innerHTML = html;
  _updateSeatVideos();
}

function renderMyCards(state) {
  const me = state.players?.find(p => p.userId === user.id);
  if (!me || !me.holeCards?.length || me.holeCards[0]?.rank === '?') return;
  renderMyHoleCards(me.holeCards);
}

function renderMyHoleCards(cards) {
  const el = document.getElementById('my-hole-cards');
  if (!cards?.length || cards[0]?.rank === '?') return;
  el.innerHTML = cards.map(c => cardHtml(c, true, true)).join('');
}

function updateActionButtons(state) {
  const isMyTurn = state.isMyTurn;
  const btnFold = document.getElementById('btn-fold');
  const btnCheck = document.getElementById('btn-check');
  const btnCall = document.getElementById('btn-call');
  const btnRaise = document.getElementById('btn-raise');
  const btnAllIn = document.getElementById('btn-allin');
  const callAmountEl = document.getElementById('call-amount');
  const raiseSlider = document.getElementById('raise-slider');
  const raiseInput = document.getElementById('raise-input');

  btnFold.disabled = !isMyTurn;
  btnCheck.disabled = !isMyTurn || !state.canCheck;
  btnCall.disabled = !isMyTurn || state.canCheck;
  btnRaise.disabled = !isMyTurn;
  if (btnAllIn) btnAllIn.disabled = !isMyTurn;

  const allinAmountEl = document.getElementById('allin-amount');

  if (isMyTurn) {
    const callAmt = state.callAmount || 0;
    callAmountEl.textContent = callAmt ? `$${fmt(callAmt)}` : '';

    const min = state.minRaiseAmount || 0;
    const max = state.maxRaiseAmount || 0;  // always = player.chips + player.currentBet
    currentMinRaise = min;
    currentMaxRaise = max;

    if (allinAmountEl) allinAmountEl.textContent = max ? `$${fmt(max)}` : '';

    // Set slider bounds to exact chip stack
    raiseSlider.min = min;
    raiseSlider.max = max;
    raiseSlider.value = min;
    raiseInput.value = min;
    raiseInput.min = min;
    raiseInput.max = max;
    updateRaiseDisplay();

    if (state.potLimitMax) {
      document.getElementById('raise-display').textContent = `up to $${fmt(Math.min(state.potLimitMax, max))}`;
    }
  } else {
    currentMinRaise = 0;
    currentMaxRaise = 0;
    if (allinAmountEl) allinAmountEl.textContent = '';
    callAmountEl.textContent = '';
  }
}

function updateHeader(state) {
  if (state.tableName) document.getElementById('hdr-table-name').textContent = state.tableName;
  document.getElementById('hdr-blinds').textContent =
    state.smallBlind ? `$${state.smallBlind}/$${state.bigBlind}` : '';
  document.getElementById('hdr-street').textContent =
    state.handActive ? (state.currentStreet || '').toUpperCase() : '';
}

// ─── Actions ──────────────────────────────────────────────────────────────

// Instant touch handler — fires before the click event on Android/iOS,
// prevents the 300ms delay and avoids double-fire from the subsequent click.
let _actTouchLock = false;
function actTouch(action, event) {
  event.preventDefault();
  if (_actTouchLock) return;
  _actTouchLock = true;
  setTimeout(() => { _actTouchLock = false; }, 800);
  // Disable all action buttons immediately for visual feedback
  ['btn-fold','btn-check','btn-call','btn-raise','btn-allin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  if (action === 'allin') { setAllIn(); act('raise'); }
  else act(action);
}

function act(action) {
  if (!socket) return;
  let amount = undefined;
  if (action === 'raise') {
    amount = parseInt(document.getElementById('raise-input').value) || 0;
    if (!amount) return toast('Enter raise amount', 'error');
    if (currentMaxRaise > 0 && amount > currentMaxRaise) {
      return toast(`Maximum raise is $${fmt(currentMaxRaise)}`, 'error');
    }
    if (currentMinRaise > 0 && amount < currentMinRaise && amount < currentMaxRaise) {
      return toast(`Minimum raise is $${fmt(currentMinRaise)}`, 'error');
    }
  }
  // Immediate local sound — others hear it via player_acted broadcast
  if (window.Sound) {
    const isAllIn = action === 'raise' && currentMaxRaise > 0 && amount >= currentMaxRaise;
    if (isAllIn)          Sound.allIn();
    else if (action === 'fold')  Sound.fold();
    else if (action === 'check') Sound.check();
    else if (action === 'call')  Sound.call();
    else if (action === 'raise') Sound.raise(amount);
  }
  socket.emit('player_action', { tableId, action, amount });
}

function setAllIn() {
  if (!currentMaxRaise) return;
  document.getElementById('raise-input').value = currentMaxRaise;
  document.getElementById('raise-slider').value = currentMaxRaise;
  updateRaiseDisplay();
}

function onRaiseSlider() {
  const slider = document.getElementById('raise-slider');
  // Browser already enforces slider min/max — just sync
  const v = parseInt(slider.value) || 0;
  document.getElementById('raise-input').value = v;
  updateRaiseDisplay();
}

function onRaiseInput() {
  const input = document.getElementById('raise-input');
  let v = parseInt(input.value) || 0;
  // Hard-cap at the player's chip stack
  if (currentMaxRaise > 0 && v > currentMaxRaise) {
    v = currentMaxRaise;
    input.value = v;
    toast(`Maximum raise is $${fmt(currentMaxRaise)}`, 'error');
  }
  document.getElementById('raise-slider').value = v;
  updateRaiseDisplay();
}

function updateRaiseDisplay() {
  const v = parseInt(document.getElementById('raise-input').value) || 0;
  const isAllIn = currentMaxRaise > 0 && v >= currentMaxRaise;
  document.getElementById('raise-display').textContent =
    isAllIn ? `$${fmt(v)} ALL IN` : (v ? `$${fmt(v)}` : '–');
}

function requestBreak() {
  socket.emit('request_break', { tableId });
}

function returnFromBreak() {
  socket.emit('return_from_break', { tableId });
}

function leaveTable() {
  // Show cashout confirmation modal instead of instant leave
  openModal('leave-confirm-modal');
}

function cashOutAndLeave() {
  closeModal('leave-confirm-modal');
  socket.emit('cashout_request', { tableId });
}

function stayAtTable() {
  closeModal('leave-confirm-modal');
}

function takeSeat(seatNumber) {
  socket.emit('join_table', { tableId, seatNumber, buyInChips: buyIn });
}

// ─── Shot Clock ───────────────────────────────────────────────────────────

function startShotClock(seconds) {
  const el = document.getElementById('shot-clock');
  const fill = document.getElementById('sc-fill');
  const num = document.getElementById('sc-number');
  el.style.display = '';
  fill.classList.remove('warning');

  const circumference = 113;
  shotClockEnd = Date.now() + seconds * 1000;

  if (shotClockInterval) clearInterval(shotClockInterval);
  let lastTickSecond = -1;
  shotClockInterval = setInterval(() => {
    const remaining = Math.max(0, shotClockEnd - Date.now()) / 1000;
    const pct = remaining / seconds;
    fill.style.strokeDashoffset = circumference * (1 - pct);
    const ceiled = Math.ceil(remaining);
    num.textContent = ceiled;
    if (remaining <= 10) fill.classList.add('warning');
    if (remaining <= 5 && ceiled !== lastTickSecond && ceiled > 0) {
      lastTickSecond = ceiled;
      if (window.Sound) Sound.timerTick();
    }
    if (remaining <= 0) stopShotClock();
  }, 100);
}

function stopShotClock() {
  if (shotClockInterval) { clearInterval(shotClockInterval); shotClockInterval = null; }
  document.getElementById('shot-clock').style.display = 'none';
  document.getElementById('sc-fill').style.strokeDashoffset = 0;
  document.getElementById('sc-fill').classList.remove('warning');
}

// ─── Hand Result ──────────────────────────────────────────────────────────

function showHandResult(result) {
  const overlay = document.getElementById('hand-result-overlay');
  const winners = result.winners || [];
  if (!winners.length) return;

  const isSplit = result.isSplitPot && winners.some(w => w.isSplit);

  if (isSplit) {
    document.getElementById('hr-winner-name').textContent = '🤝 Split Pot!';
    document.getElementById('hr-hand-name').textContent = winners[0].handName || 'Tied Hands';
    document.getElementById('hr-amount').textContent = winners.map(w => `${esc(w.username)}: +$${fmt(w.amount)}`).join('  |  ');
    document.getElementById('hr-cards').innerHTML = winners.map(w =>
      `<div class="split-winner-cards"><span class="split-winner-name">${esc(w.username)}</span>${(w.holeCards || []).map(c => cardHtml(c, true)).join('')}</div>`
    ).join('');
  } else {
    const w = winners[0];
    document.getElementById('hr-winner-name').textContent = w.username;
    document.getElementById('hr-hand-name').textContent = result.folded ? 'Everyone folded' : (w.handName || '');
    document.getElementById('hr-amount').textContent = `+$${fmt(w.amount)}`;
    document.getElementById('hr-cards').innerHTML = (w.holeCards || []).map(c => cardHtml(c, true)).join('');
  }

  // Side pot breakdown + rake line
  const rakeEl = document.getElementById('hr-rake');
  if (rakeEl) {
    let footerText = '';
    if (result.potBreakdown?.length > 1) {
      footerText = result.potBreakdown.map(p => `${p.label}: $${fmt(p.amount)}`).join('  •  ');
    }
    if (result.rakeCollected) {
      footerText += (footerText ? '  •  ' : '') + `Rake: $${fmt(result.rakeCollected)}`;
    }
    rakeEl.textContent = footerText;
  }

  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), isSplit ? 6000 : 4000);
}

function hideHandResult() {
  document.getElementById('hand-result-overlay').classList.add('hidden');
}

// ─── Jackpot ──────────────────────────────────────────────────────────────

let jackpotTimerInterval = null;
let tableJackpotTimerStart = 0;
const JACKPOT_INTERVAL_MS_TABLE = 30 * 60 * 1000;

function updateJackpotDisplay(data) {
  const tables = data.tables || [];
  const myJp = tables.find(t => t.tableId === tableId) || tables[0];

  // Only show amount if jackpot is active for this table
  const amount = (myJp && myJp.isActive) ? myJp.amount : 0;
  document.getElementById('hdr-jackpot').textContent = amount > 0 ? `🏆 $${fmt(amount)}` : '🏆 –';

  const timerEl = document.getElementById('hdr-jackpot-timer');
  if (!timerEl) return;

  if (!myJp || !myJp.isActive) {
    timerEl.textContent = '';
    if (jackpotTimerInterval) { clearInterval(jackpotTimerInterval); jackpotTimerInterval = null; }
    return;
  }

  if (myJp.awaitingPayout) {
    timerEl.textContent = 'Payout Due';
    timerEl.style.color = 'var(--red)';
    if (jackpotTimerInterval) { clearInterval(jackpotTimerInterval); jackpotTimerInterval = null; }
    return;
  }

  if (myJp.isOnHold) {
    const remaining = myJp.timerRemainingMs || 0;
    const min = Math.floor(remaining / 60000);
    const sec = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `⏸ ${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    timerEl.style.color = 'var(--gold)';
    if (jackpotTimerInterval) { clearInterval(jackpotTimerInterval); jackpotTimerInterval = null; }
    return;
  }

  // Active and running — start/update live countdown
  tableJackpotTimerStart = myJp.timerStart;
  if (!jackpotTimerInterval) {
    jackpotTimerInterval = setInterval(() => {
      const remaining = Math.max(0, JACKPOT_INTERVAL_MS_TABLE - (Date.now() - tableJackpotTimerStart));
      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      const el = document.getElementById('hdr-jackpot-timer');
      if (el) {
        el.textContent = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')} left`;
        el.style.color = remaining < 5 * 60 * 1000 ? 'var(--red)' : '';
      }
    }, 1000);
  }
}

function openHostHighHandModal() {
  const existing = document.getElementById('host-hh-modal');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.id = 'host-hh-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
  div.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:24px 28px;max-width:400px;width:100%">
      <h3 style="color:var(--gold);margin:0 0 16px">🏆 Submit High Hand</h3>
      <div class="form-group" style="margin-bottom:12px">
        <label style="color:var(--text-dim);font-size:.82rem">Player Name</label>
        <input id="hh-player-name" type="text" maxlength="60" placeholder="e.g. Maverick"
          style="width:100%;padding:9px 12px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);box-sizing:border-box">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="color:var(--text-dim);font-size:.82rem">Hand Description</label>
        <input id="hh-hand-desc" type="text" maxlength="120" placeholder="e.g. Aces Full of Kings"
          style="width:100%;padding:9px 12px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);box-sizing:border-box">
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label style="color:var(--text-dim);font-size:.82rem">Hand Rank</label>
        <select id="hh-hand-rank" style="width:100%;padding:9px 12px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
          <option value="9">9 — Royal Flush</option>
          <option value="8">8 — Straight Flush</option>
          <option value="7">7 — Four of a Kind</option>
          <option value="6" selected>6 — Full House</option>
          <option value="5">5 — Flush</option>
          <option value="4">4 — Straight</option>
          <option value="3">3 — Three of a Kind</option>
          <option value="2">2 — Two Pair</option>
          <option value="1">1 — One Pair</option>
        </select>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-gold" style="flex:1" onclick="submitHostHighHand()">Submit High Hand</button>
        <button class="btn btn-outline" onclick="document.getElementById('host-hh-modal').remove()">Cancel</button>
      </div>
      <div id="hh-submit-status" style="margin-top:8px;font-size:.82rem;color:var(--chip-green)"></div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

function submitHostHighHand() {
  const playerName = document.getElementById('hh-player-name')?.value.trim();
  const handDesc = document.getElementById('hh-hand-desc')?.value.trim();
  const handRank = parseInt(document.getElementById('hh-hand-rank')?.value || '6');
  const status = document.getElementById('hh-submit-status');
  if (!playerName) { if (status) status.textContent = 'Player name is required.'; return; }
  if (!handDesc) { if (status) status.textContent = 'Hand description is required.'; return; }
  if (!socket) return;
  socket.emit('jackpot:set_high_hand', { tableId, holderName: playerName, description: handDesc, handRank });
  if (status) status.textContent = 'High hand submitted!';
  setTimeout(() => { document.getElementById('host-hh-modal')?.remove(); }, 1200);
}

// ─── Chat ─────────────────────────────────────────────────────────────────

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat_message', { tableId, message: msg });
  input.value = '';
}

function chatMsg(name, text, type) {
  const el = document.getElementById('chat-messages');
  const isSystem = name === 'system';
  const div = document.createElement('div');

  if (type === 'sticker') {
    div.className = 'chat-msg chat-sticker-msg';
    div.innerHTML = `<span class="chat-name">${esc(name)}:</span> <span class="chat-sticker">${_renderSticker(text)}</span>`;
  } else if (type === 'gif') {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-name">${esc(name)}:</span> <span class="chat-text">${esc(text)}</span>`;
  } else {
    div.className = `chat-msg ${isSystem ? 'system' : ''}`;
    div.innerHTML = isSystem
      ? `<span class="chat-text">${esc(text)}</span>`
      : `<span class="chat-name">${esc(name)}:</span> <span class="chat-text">${esc(text)}</span>`;
  }

  el.appendChild(div);
  el.scrollTop = el.scrollHeight;

  // Persist to session storage (skip system messages to reduce noise)
  if (!isSystem) {
    _chatHistory.push({ name, text, type, ts: Date.now() });
    if (_chatHistory.length > 150) _chatHistory = _chatHistory.slice(-100);
    try { sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(_chatHistory)); } catch {}
  }
}

function _renderSticker(key) {
  const stickers = {
    'nicehd':  '<div class="sticker s-nicehd" title="Nice Hand">🤝</div>',
    'onfire':  '<div class="sticker s-onfire" title="On Fire">🔥</div>',
    'bust':    '<div class="sticker s-bust" title="Busted">💀</div>',
    'money':   '<div class="sticker s-money" title="Money">🤑</div>',
    'rabbit':  '<div class="sticker s-rabbit" title="Rabbit">🐰</div>',
    'cool':    '<div class="sticker s-cool" title="Cool">😎</div>',
    'facepalm':'<div class="sticker s-facepalm" title="Bad Beat">🤦</div>',
    'winner':  '<div class="sticker s-winner" title="Winner">🏆</div>',
  };
  return stickers[key] || esc(key);
}

document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function cardHtml(card, appear = false, large = false) {
  if (!card || card.rank === '?') return '<div class="card back"></div>';
  const isRed   = card.suit === '♥' || card.suit === '♦';
  const isFace  = ['J', 'Q', 'K'].includes(card.rank);
  const isAce   = card.rank === 'A';
  const colorCls = isRed ? 'red' : 'black';

  let center;
  if (isFace) {
    center = `<div class="card-center face-card"><span class="card-face-letter">${card.rank}</span><span class="card-face-suit">${card.suit}</span></div>`;
  } else if (isAce) {
    center = `<div class="card-center ace-card">${card.suit}</div>`;
  } else {
    center = `<div class="card-center">${card.suit}</div>`;
  }

  return `<div class="card ${colorCls}${large ? ' large' : ''}${appear ? ' card-appear' : ''}" title="${card.rank}${card.suit}">
    <div class="card-corner tl"><span class="card-rank">${card.rank}</span><span class="card-pip">${card.suit}</span></div>
    ${center}
    <div class="card-corner br"><span class="card-rank">${card.rank}</span><span class="card-pip">${card.suit}</span></div>
  </div>`;
}

function fmt(n) { const v = Number(n); return (isNaN(v) || n == null) ? '0' : v.toLocaleString(); }
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

const toastContainer = document.getElementById('toast-container');
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function showAdminMessageToast(from, message, pending, msgId) {
  const existing = document.getElementById('admin-msg-overlay');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'admin-msg-overlay';
  div.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9500;max-width:380px;width:92%;background:#0a1a12;border:2px solid var(--gold);border-radius:12px;padding:16px 20px;box-shadow:0 8px 32px rgba(0,0,0,.6)';
  const esc2 = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  div.innerHTML = `
    <div style="font-size:.72rem;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">📨 ${pending ? 'Missed message' : 'Message from Admin'} — ${esc2(from)}</div>
    <div style="color:var(--text);font-size:.9rem;line-height:1.5;margin-bottom:10px">${esc2(message)}</div>
    <textarea id="table-reply-input" placeholder="Reply to admin…" maxlength="500" rows="2"
      style="width:100%;padding:7px 9px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);resize:none;font-family:inherit;font-size:.83rem;box-sizing:border-box;margin-bottom:8px"></textarea>
    <div style="display:flex;gap:8px;align-items:center">
      <button onclick="sendTableReply(${msgId || 'null'})" style="background:none;border:1px solid var(--gold);color:var(--gold);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:.78rem">Send Reply</button>
      <button onclick="document.getElementById('admin-msg-overlay').remove()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text-dim);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:.78rem">Dismiss</button>
      <button onclick="document.getElementById('admin-msg-overlay').remove();openTableInbox()" style="background:none;border:none;color:var(--text-dim);padding:4px 8px;cursor:pointer;font-size:.78rem">Inbox</button>
      <span id="table-reply-status" style="color:var(--chip-green);font-size:.75rem"></span>
    </div>`;
  document.body.appendChild(div);
  setTimeout(() => { const el = document.getElementById('admin-msg-overlay'); if (el) el.remove(); }, 20000);
}

function sendTableReply(replyToId) {
  const input = document.getElementById('table-reply-input');
  const status = document.getElementById('table-reply-status');
  if (!input || !socket) return;
  const text = input.value.trim();
  if (!text) return;
  socket.emit('player:reply', { replyToId, message: text });
  input.value = '';
  input.disabled = true;
  if (status) { status.textContent = 'Sent!'; setTimeout(() => { status.textContent = ''; if (input) input.disabled = false; }, 3000); }
}

function updateTableInboxBadge() {
  const badge = document.getElementById('table-inbox-badge');
  if (!badge) return;
  const lastRead = parseInt(localStorage.getItem(TABLE_INBOX_READ_KEY) || '0');
  const unread = tableInboxMessages.filter(m => m.sentAt > lastRead).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function openTableInbox() {
  const existing = document.getElementById('table-inbox-modal');
  if (existing) { existing.remove(); return; }
  localStorage.setItem(TABLE_INBOX_READ_KEY, Date.now().toString());
  updateTableInboxBadge();
  const esc2 = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const msgs = tableInboxMessages.length
    ? tableInboxMessages.map(m => `
        <div style="border-bottom:1px solid rgba(255,255,255,.08);padding:12px 0">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="color:var(--gold);font-weight:700;font-size:.85rem">📨 ${esc2(m.from)}</span>
            <span style="color:var(--text-dim);font-size:.72rem">${new Date(m.sentAt).toLocaleString()}</span>
          </div>
          <div style="color:var(--text);font-size:.9rem;line-height:1.5">${esc2(m.message)}</div>
        </div>`).join('')
    : '<div style="color:var(--text-dim);text-align:center;padding:30px">No messages yet</div>';
  const div = document.createElement('div');
  div.id = 'table-inbox-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
  div.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:24px;max-width:500px;width:100%;max-height:80vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="color:var(--gold);margin:0">📬 Message Inbox</h2>
        <button onclick="document.getElementById('table-inbox-modal').remove()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text);border-radius:6px;padding:3px 10px;cursor:pointer">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1">${msgs}</div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

// ─── Camera ───────────────────────────────────────────────────────────────────

function _getCamVideoSender(pc) {
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track.kind === 'video') return t.sender;
  }
  return null;
}

async function _camEnable() {
  console.log('[CAM] enabling camera...');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
      audio: false
    });
    camEnabled = true;
    const [videoTrack] = camStream.getVideoTracks();
    console.log('[CAM] got video track:', videoTrack?.label, 'readyState:', videoTrack?.readyState);
    // Push video track to all existing peer connections
    for (const [peerId, pc] of pttPeers) {
      const sender = _getCamVideoSender(pc);
      if (sender) {
        try {
          await sender.replaceTrack(videoTrack);
          console.log(`[CAM] replaceTrack sent to ${peerId}`);
        } catch (err) {
          console.warn(`[CAM] replaceTrack failed for ${peerId}:`, err.message);
        }
      }
    }
    _updateCamBtn();
    _updateSeatVideos();
    socket?.emit('cam:state_change', { enabled: true });
  } catch (err) {
    console.error('[CAM] getUserMedia error:', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      toast('Camera permission denied — check browser settings', 'error');
    } else {
      toast('Camera error: ' + err.message, 'error');
    }
  }
}

function _camDisable() {
  for (const [, pc] of pttPeers) {
    const sender = _getCamVideoSender(pc);
    if (sender) sender.replaceTrack(null).catch(() => {});
  }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  camEnabled = false;
  _updateCamBtn();
  _updateSeatVideos();
  socket?.emit('cam:state_change', { enabled: false });
}

function toggleCamera() {
  if (camEnabled) _camDisable();
  else _camEnable();
}

function _updateCamBtn() {
  const btn = document.getElementById('cam-toggle-btn');
  if (!btn) return;
  btn.textContent = camEnabled ? '📷' : '📷';
  btn.style.opacity = camEnabled ? '1' : '0.5';
  btn.title = camEnabled ? 'Camera on — click to turn off' : 'Camera off — click to enable';
  btn.style.borderColor = camEnabled ? 'var(--chip-green)' : '';
}

function _updateSeatVideos() {
  // Local player's seat
  const myAvatar = document.querySelector(`.seat-avatar[data-cam-uid="${user.id}"]`);
  if (myAvatar) {
    if (camEnabled && camStream) _setAvatarVideo(myAvatar, camStream, true);
    else _clearAvatarVideo(myAvatar);
  }
  // Remote players
  for (const [uid, stream] of peerCamStreams) {
    const enabled = peerCamEnabled.get(uid);
    const hasLiveVideo = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
    const avatarEl = document.querySelector(`.seat-avatar[data-cam-uid="${uid}"]`);
    if (!avatarEl) { _checkAdminCamStream(); continue; }
    if (enabled || hasLiveVideo) _setAvatarVideo(avatarEl, stream, false);
    else _clearAvatarVideo(avatarEl);
  }
}

function _setAvatarVideo(avatarEl, stream, muted) {
  const uid = avatarEl.dataset.camUid;
  console.log(`[CAM] _setAvatarVideo uid=${uid} muted=${muted} tracks=${stream?.getVideoTracks().length}`);
  let vid = avatarEl.querySelector('video');
  if (!vid) {
    vid = document.createElement('video');
    vid.className = 'seat-cam-video';
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = muted;
    vid.onplaying = () => console.log(`[CAM] video playing for uid=${uid}`);
    vid.onclick = () => _expandCamVideo(vid, avatarEl.dataset.camUid);
    avatarEl.appendChild(vid);
  }
  if (vid.srcObject !== stream) {
    vid.srcObject = stream;
    console.log(`[CAM] set srcObject for uid=${uid}`);
  }
  // Add class after paint so CSS opacity transition fires (avatar fades out, video fades in)
  requestAnimationFrame(() => avatarEl.classList.add('has-video'));
  vid.play().catch(err => console.warn(`[CAM] play() failed for uid=${uid}:`, err.message));
}

function _clearAvatarVideo(avatarEl) {
  avatarEl.classList.remove('has-video'); // triggers CSS fade-out of video, fade-in of avatar
  const vid = avatarEl.querySelector('video');
  if (!vid) return;
  const cleanup = () => { if (vid.parentNode) { vid.srcObject = null; vid.remove(); } };
  vid.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 500); // fallback if transitionend doesn't fire
}

function _expandCamVideo(vid, userId) {
  const existing = document.getElementById('cam-expand-overlay');
  if (existing) { existing.remove(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'cam-expand-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9990;display:flex;align-items:center;justify-content:center;cursor:pointer';
  overlay.onclick = () => overlay.remove();
  const bigVid = document.createElement('video');
  bigVid.autoplay = true;
  bigVid.playsInline = true;
  bigVid.muted = vid.muted;
  bigVid.srcObject = vid.srcObject;
  bigVid.style.cssText = 'max-width:90vw;max-height:80vh;border-radius:16px;border:2px solid var(--gold);box-shadow:0 0 40px rgba(0,0,0,.8)';
  overlay.appendChild(bigVid);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'position:absolute;top:20px;right:24px;background:none;border:none;color:#fff;font-size:1.8rem;cursor:pointer;line-height:1';
  closeBtn.onclick = (e) => { e.stopPropagation(); overlay.remove(); };
  overlay.appendChild(closeBtn);
  bigVid.play().catch(() => {});
  document.body.appendChild(overlay);
}

function _showCamPrompt() {
  if (camStream) return;
  if (localStorage.getItem('rp_cam_opt_in') === '1') { _camEnable(); return; }
  if (sessionStorage.getItem('rp_cam_skip')) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'cam-prompt-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width:380px;text-align:center;padding:28px 24px">
      <div style="font-size:3rem;margin-bottom:10px">📸</div>
      <h3 style="color:var(--gold);margin:0 0 8px">Enable Camera?</h3>
      <p style="color:var(--text-dim);font-size:.88rem;margin:0 0 22px">Other players can see you during the game.<br>You can turn it off anytime.</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="btn btn-outline" onclick="_camPromptSkip()">Skip</button>
        <button class="btn btn-gold" onclick="_camPromptEnable()">📷 Enable Camera</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _camPromptSkip() {
  sessionStorage.setItem('rp_cam_skip', '1');
  document.getElementById('cam-prompt-modal')?.remove();
}

function _camPromptEnable() {
  document.getElementById('cam-prompt-modal')?.remove();
  _camEnable();
}

function openCamGrid() {
  const existing = document.getElementById('cam-grid-modal');
  if (existing) { existing.remove(); return; }
  const u = getUser();
  if (!u?.isAdmin) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'cam-grid-modal';
  const streams = [];
  // Add local cam
  if (camEnabled && camStream) streams.push({ label: 'You', stream: camStream, muted: true, uid: user.id });
  // Add remote cams
  for (const [uid, stream] of peerCamStreams) {
    if (peerCamEnabled.get(uid)) {
      const p = gameState?.players?.find(pl => pl.userId === uid);
      streams.push({ label: p?.username || uid, stream, muted: false, uid });
    }
  }
  if (!streams.length) { toast('No active cameras'); return; }
  const cells = streams.map(s => `
    <div style="position:relative;background:#000;border-radius:10px;overflow:hidden">
      <video id="cg-vid-${s.uid}" autoplay playsinline ${s.muted ? 'muted' : ''} style="width:100%;display:block"></video>
      <div style="position:absolute;bottom:4px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:.72rem;padding:2px 6px;border-radius:4px">${esc(s.label)}</div>
      ${u?.isAdmin && s.uid !== user.id ? `<button onclick="adminDisableCam('${s.uid}')" style="position:absolute;top:4px;right:4px;background:rgba(200,0,0,.7);border:none;color:#fff;font-size:.65rem;padding:2px 6px;border-radius:4px;cursor:pointer">Disable</button>` : ''}
    </div>`).join('');
  modal.innerHTML = `
    <div class="modal" style="max-width:720px;width:95vw;max-height:85vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="color:var(--gold);margin:0">📷 Camera Grid</h3>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-outline" onclick="adminDisableAllCams()" style="font-size:.78rem">Disable All</button>
          <button class="btn btn-sm btn-outline" onclick="document.getElementById('cam-grid-modal')?.remove()" style="font-size:.78rem">✕ Close</button>
        </div>
      </div>
      <div id="cam-grid-cells" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">${cells}</div>
    </div>`;
  document.body.appendChild(modal);
  // Attach streams AFTER adding to DOM
  for (const s of streams) {
    const v = document.getElementById(`cg-vid-${s.uid}`);
    if (v) { v.srcObject = s.stream; v.play().catch(() => {}); }
  }
}

function adminDisableCam(targetUserId) {
  socket?.emit('cam:admin_disable', { targetUserId });
  peerCamEnabled.set(targetUserId, false);
  _updateSeatVideos();
  document.getElementById('cam-grid-modal')?.remove();
}

function adminDisableAllCams() {
  socket?.emit('cam:admin_disable_all');
  for (const uid of peerCamEnabled.keys()) peerCamEnabled.set(uid, false);
  _updateSeatVideos();
  document.getElementById('cam-grid-modal')?.remove();
}

// ─── PTT Core Helpers ─────────────────────────────────────────────────────────

// Build and wire a fresh RTCPeerConnection for peerId.
// Adds mic tracks immediately if available (must happen BEFORE createOffer/createAnswer).
function _pttCreatePC(peerId, addTrackNow = true) {
  // Tear down any existing connection and audio element for this peer
  if (pttPeers.has(peerId)) { pttPeers.get(peerId).close(); pttPeers.delete(peerId); }
  const oldAudio = pttAudioEls.get(peerId);
  if (oldAudio) { oldAudio.srcObject = null; oldAudio.remove(); pttAudioEls.delete(peerId); }
  pttPending.set(peerId, []);

  const pc = new RTCPeerConnection(ICE_CFG);
  pttPeers.set(peerId, pc);

  // Dedicated audio output element
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.appendChild(audio);
  pttAudioEls.set(peerId, audio);

  // Route incoming tracks — audio to the dedicated audio element, video to the seat avatar
  pc.ontrack = (e) => {
    const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
    if (e.track.kind === 'audio') {
      console.log(`[PTT] audio track from ${peerId}`);
      audio.srcObject = stream;
      audio.play().catch(err => console.warn('[PTT] autoplay blocked:', err.message));
    } else if (e.track.kind === 'video') {
      console.log(`[CAM] video track from ${peerId}, readyState=${e.track.readyState}`);
      peerCamStreams.set(peerId, stream);
      peerCamEnabled.set(peerId, true);
      _updateSeatVideos();
      e.track.onunmute = () => {
        console.log(`[CAM] video track unmuted (live) from ${peerId}`);
        peerCamEnabled.set(peerId, true);
        _updateSeatVideos();
      };
    }
  };

  // Relay our ICE candidates to the peer
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ptt:signal', { targetUserId: peerId, signal: { type: 'ice', candidate: e.candidate.toJSON() } });
    }
  };

  pc.onconnectionstatechange = () => console.log(`[PTT] ${peerId} connection: ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => {
    console.log(`[PTT] ${peerId} ICE: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.warn(`[PTT] ICE failed with ${peerId} — attempting restart`);
      pc.restartIce();
    }
  };

  // Offerer adds track now (SDP must include audio section for sendrecv).
  // Answerer defers track-adding until after setRemoteDescription to avoid duplicate mid.
  if (addTrackNow) {
    if (micStream) {
      const [audioTrack] = micStream.getAudioTracks();
      if (audioTrack) {
        pc.addTransceiver(audioTrack, { streams: [micStream], direction: 'sendrecv' });
        console.log(`[PTT] added sendrecv transceiver for ${peerId}`);
      }
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      console.warn(`[PTT] no mic for ${peerId} — recvonly transceiver`);
    }
    // Always pre-negotiate video (sendrecv) so replaceTrack works later without renegotiation
    const camVideoTrack = camStream ? camStream.getVideoTracks()[0] : null;
    pc.addTransceiver(camVideoTrack || 'video', {
      direction: 'sendrecv',
      streams: camStream ? [camStream] : []
    });
  }

  return pc;
}

// Send an offer to peerId (we initiate)
async function _pttOffer(peerId) {
  const pc = _pttCreatePC(peerId, true); // offerer adds transceiver immediately
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('ptt:signal', { targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription.sdp } });
    console.log('[PTT] offer sent to', peerId);
  } catch (err) {
    console.error('[PTT] offer failed for', peerId, ':', err.message);
    pttPeers.delete(peerId);
    pc.close();
  }
}

// Respond with an answer to an offer from fromUserId
async function _pttAnswer(fromUserId, sdp) {
  // Don't add track now — do it after setRemoteDescription to avoid duplicate mids
  const pc = _pttCreatePC(fromUserId, false);
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    // Flush any ICE candidates that arrived before the offer
    for (const c of (pttPending.get(fromUserId) || [])) {
      try { await pc.addIceCandidate(c); } catch {}
    }
    pttPending.set(fromUserId, []);
    // Add mic to the existing transceiver (AFTER setRemoteDescription — avoids duplicate mids)
    if (micStream) {
      const [audioTrack] = micStream.getAudioTracks();
      const transceivers = pc.getTransceivers();
      if (transceivers.length > 0 && audioTrack) {
        await transceivers[0].sender.replaceTrack(audioTrack);
        transceivers[0].direction = 'sendrecv';
        console.log(`[PTT] answer: set sendrecv track on transceiver for ${fromUserId}`);
      } else if (audioTrack) {
        pc.addTrack(audioTrack, micStream);
      }
    }
    // Set up video transceiver on answerer side
    const videoTransceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
    if (videoTransceiver) {
      if (camStream) {
        const [videoTrack] = camStream.getVideoTracks();
        if (videoTrack) {
          await videoTransceiver.sender.replaceTrack(videoTrack);
          videoTransceiver.direction = 'sendrecv';
        }
      }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('ptt:signal', { targetUserId: fromUserId, signal: { type: 'answer', sdp: pc.localDescription.sdp } });
    console.log('[PTT] answer sent to', fromUserId);
  } catch (err) {
    console.error('[PTT] answer failed for', fromUserId, ':', err.message);
    pttPeers.delete(fromUserId);
    pc.close();
  }
}

// Close all peer connections and audio elements
function _pttCloseMesh() {
  for (const [, pc] of pttPeers) pc.close();
  pttPeers.clear();
  for (const [, audio] of pttAudioEls) { audio.srcObject = null; audio.remove(); }
  pttAudioEls.clear();
  pttPending.clear();
}

// ─── Mic acquisition ──────────────────────────────────────────────────────────

async function _pttAcquireMic() {
  if (micStream) return true; // already acquired
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    micStream.getAudioTracks().forEach(t => { t.enabled = false; }); // start muted
    console.log('[PTT] mic acquired:', micStream.getAudioTracks().map(t => t.label));
    _pttShowMicReady();
    return true;
  } catch (err) {
    console.error('[PTT] getUserMedia error:', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showMicDeniedBanner();
    } else {
      toast('Microphone error: ' + err.message, 'error');
    }
    return false;
  }
}

// Acquire mic then join PTT mesh — called on joined_table
async function _pttInit() {
  await _pttAcquireMic(); // request permission; shows banner on denial
  socket.emit('ptt:mesh_join'); // join mesh regardless (can receive audio even without mic)
}

function _pttShowMicReady() {
  const btn = document.getElementById('ptt-btn');
  if (btn) {
    btn.style.borderColor = 'var(--chip-green)';
    btn.title = 'Mic ready — hold to talk';
  }
  // Brief green flash on mic-test button
  const micBtn = document.getElementById('mic-test-btn');
  if (micBtn) { micBtn.style.color = 'var(--chip-green)'; setTimeout(() => { micBtn.style.color = ''; }, 2000); }
}

function showMicDeniedBanner() {
  if (document.getElementById('mic-denied-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'mic-denied-banner';
  banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#e63946;color:#fff;padding:10px 18px;border-radius:8px;z-index:9999;font-size:.9rem;text-align:center;cursor:pointer;max-width:90vw;box-shadow:0 4px 16px rgba(0,0,0,.5)';
  banner.innerHTML = '🎙 Microphone blocked. <u>Click here</u> to see how to enable in browser settings, then refresh.';
  banner.onclick = () => banner.remove();
  document.body.appendChild(banner);
}

// ─── Push to Talk ─────────────────────────────────────────────────────────────

async function startPTT(e) {
  if (e) e.preventDefault();
  if (pttActive) return;
  if (adminMuted) { toast('Your mic has been muted by admin', 'error'); return; }
  if (openMicMode) return; // open-mic transmits automatically

  // If mic wasn't acquired at join time, try again now
  if (!micStream) {
    const ok = await _pttAcquireMic();
    if (!ok) return;
    // Rejoin mesh now that we have a mic track to include in the SDP
    _pttCloseMesh();
    socket.emit('ptt:mesh_join');
    // Wait for ICE negotiation (TURN can take up to ~1s)
    await new Promise(r => setTimeout(r, 1500));
  }

  micStream.getAudioTracks().forEach(t => { t.enabled = true; });
  pttActive = true;
  const btn = document.getElementById('ptt-btn');
  if (btn) { btn.classList.add('speaking'); btn.textContent = '🔴 Talking…'; }
  socket.emit('ptt:talking');
  setSpeakingIndicator(user.id, true, user.username || user.nickname || 'You');
}

function stopPTT() {
  if (!pttActive) return;
  if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = false; });
  pttActive = false;
  const btn = document.getElementById('ptt-btn');
  if (btn) { btn.classList.remove('speaking'); btn.textContent = '🎙 Hold to Talk'; }
  socket.emit('ptt:silent');
  setSpeakingIndicator(user.id, false);
}

function _startOpenMic() {
  if (openMicActive || adminMuted || !micStream) return;
  openMicActive = true;
  micStream.getAudioTracks().forEach(t => { t.enabled = true; });
  socket.emit('ptt:talking');
  setSpeakingIndicator(user.id, true, user.username || 'Me');
}

function _stopOpenMic() {
  if (!openMicActive) return;
  openMicActive = false;
  if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = false; });
  socket.emit('ptt:silent');
  setSpeakingIndicator(user.id, false);
}

// ─── Mic Test (3-second record + playback) ────────────────────────────────────

let _micTestActive = false;

async function testMic() {
  if (_micTestActive) { document.getElementById('mic-test-panel')?.remove(); _micTestActive = false; return; }
  const btn = document.getElementById('mic-test-btn');
  if (btn) { btn.textContent = '⏺ Starting…'; btn.disabled = true; }
  _micTestActive = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      _showMicPlayback(URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })));
      if (btn) { btn.textContent = '🎚 Mic'; btn.disabled = false; }
      _micTestActive = false;
    };
    recorder.start();
    let secs = 3;
    if (btn) btn.textContent = `⏺ Rec ${secs}s…`;
    const iv = setInterval(() => { secs--; if (btn) btn.textContent = secs > 0 ? `⏺ Rec ${secs}s…` : '⏹ Done'; if (secs <= 0) clearInterval(iv); }, 1000);
    setTimeout(() => recorder.stop(), 3000);
  } catch (err) {
    console.error('[MIC TEST]', err.name, err.message);
    if (err.name === 'NotAllowedError') toast('Microphone blocked — allow in browser settings', 'error');
    else toast('Mic error: ' + err.message, 'error');
    if (btn) { btn.textContent = '🎚 Mic'; btn.disabled = false; }
    _micTestActive = false;
  }
}

function _showMicPlayback(url) {
  document.getElementById('mic-test-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'mic-test-panel';
  panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:24px 28px;z-index:9999;text-align:center;min-width:280px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.8)';
  panel.innerHTML = `
    <div style="font-size:2rem;margin-bottom:8px">🎙</div>
    <div style="color:var(--gold);font-weight:700;font-size:1rem;margin-bottom:6px">Mic Test — 3s Recording</div>
    <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-bottom:14px">Press ▶ to hear your recording:</div>
    <audio controls src="${url}" style="width:100%;margin-bottom:16px"></audio>
    <div style="display:flex;gap:10px;justify-content:center">
      <button onclick="document.getElementById('mic-test-panel').remove()" class="btn btn-outline" style="flex:1">Close</button>
      <button onclick="document.getElementById('mic-test-panel').remove();startPTT()" class="btn btn-gold" style="flex:1">✅ Talk Now</button>
    </div>`;
  document.body.appendChild(panel);
}

// ─── Speaking indicator (red pulse = you, green ring = others) ────────────────

function setSpeakingIndicator(targetUserId, active, username) {
  const seatBox = document.querySelector(`.seat-box[data-user-id="${targetUserId}"]`);
  if (!seatBox) {
    if (active) toast(`🎙 ${username || 'Player'} is speaking`);
    return;
  }
  seatBox.classList.toggle('ptt-speaking', active);
}

// ─── Admin PTT Panel ──────────────────────────────────────────────────────────

function renderAdminPttPanel(players, mode) {
  const u = getUser();
  if (!u?.isAdmin) return;

  const panel = document.getElementById('mic-controls-panel');
  const inner = document.getElementById('mic-controls-inner');
  if (!panel || !inner) return;

  const isOpenMic = mode !== undefined ? mode === 'openmic' : openMicMode;

  const modeLabel = isOpenMic
    ? '<span class="mic-mode-badge open">📢 Open Mic — Active</span>'
    : '<span class="mic-mode-badge ptt">🎙 PTT Mode</span>';

  const modeToggleLabel = isOpenMic ? '↩ Switch to PTT' : '📢 Open Mic';
  const modeToggleClass = isOpenMic ? 'mic-btn mic-btn-mode-ptt' : 'mic-btn mic-btn-mode-open';

  let rows = '';
  if (players && players.length) {
    for (const p of players) {
      const isSpeaking  = !p.mutedByAdmin && p.micStatus === 'speaking';
      const isMuted     = p.mutedByAdmin;
      const iconEmoji   = isMuted ? '🔇' : (isSpeaking ? '🔴' : '🎙');
      const iconClass   = isSpeaking ? 'mic-status-icon speaking' : 'mic-status-icon';
      const iconColor   = isMuted ? 'color:#e74c3c' : (isSpeaking ? 'color:#e74c3c' : 'color:var(--chip-green)');
      const btnClass    = isMuted ? 'mic-toggle-btn unmute' : 'mic-toggle-btn mute';
      const btnLabel    = isMuted ? 'Unmute' : 'Mute';
      const btnAction   = isMuted ? `adminUnmutePlayer('${p.userId}')` : `adminMutePlayer('${p.userId}')`;
      const hasCam = peerCamEnabled.get(p.userId);
      const camBtnHtml = hasCam
        ? `<button class="mic-toggle-btn mute" onclick="adminDisableCam('${p.userId}')">📷 Off</button>`
        : '';
      rows += `
        <div class="mic-player-row">
          <span class="${iconClass}" style="${iconColor}">${iconEmoji}</span>
          <span class="mic-player-name">${p.username}</span>
          <button class="${btnClass}" onclick="${btnAction}">${btnLabel}</button>
          ${camBtnHtml}
        </div>`;
    }
  } else {
    rows = '<div style="color:var(--text-dim);font-size:.8rem;padding:4px 0">No players seated</div>';
  }

  inner.innerHTML = `
    <div class="mic-panel-actions">
      <button class="mic-btn mic-btn-mute-all"   onclick="adminMuteAll()">🔇 Mute All</button>
      <button class="mic-btn mic-btn-unmute-all" onclick="adminUnmuteAll()">🔊 Unmute All</button>
      <button class="mic-btn"                    onclick="openCamGrid()" style="background:rgba(200,160,0,.15);border-color:var(--gold)">📷 Cameras</button>
      <button class="${modeToggleClass}" onclick="adminToggleMode()">${modeToggleLabel}</button>
    </div>
    ${rows}
    <div class="mic-mode-bar">Current mode: ${modeLabel}</div>`;

  panel.style.display = '';

  // Apply saved collapse state; default to collapsed on mobile
  const saved = localStorage.getItem('micPanelCollapsed');
  const defaultCollapsed = window.innerWidth <= 768;
  const shouldCollapse = saved !== null ? saved === '1' : defaultCollapsed;
  panel.classList.toggle('collapsed', shouldCollapse);
  const collapseBtn = panel.querySelector('.mic-collapse-btn');
  if (collapseBtn) collapseBtn.textContent = shouldCollapse ? '+' : '−';
}

function toggleHostPanel() {
  const panel = document.getElementById('host-controls');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  localStorage.setItem('rp_host_panel_collapsed', collapsed ? '1' : '0');
  const btn = panel.querySelector('.host-collapse-btn');
  if (btn) btn.textContent = collapsed ? '+' : '−';
}

function toggleMicPanel() {
  const panel = document.getElementById('mic-controls-panel');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  localStorage.setItem('micPanelCollapsed', collapsed ? '1' : '0');
  const btn = panel.querySelector('.mic-collapse-btn');
  if (btn) btn.textContent = collapsed ? '+' : '−';
}

function adminMuteAll()   { socket?.emit('ptt:admin_mute_all'); }
function adminUnmuteAll() { socket?.emit('ptt:admin_unmute_all'); }
function adminToggleMode() {
  socket?.emit('ptt:admin_set_mode', { mode: openMicMode ? 'ptt' : 'openmic' });
}
function adminMutePlayer(targetUserId)   { socket?.emit('ptt:admin_mute',   { targetUserId }); }
function adminUnmutePlayer(targetUserId) { socket?.emit('ptt:admin_unmute', { targetUserId }); }

// ─── Seat Timer ───────────────────────────────────────────────────────────

function startSeatTimer(seatNumber, seconds) {
  clearSeatTimer();
  const endTime = Date.now() + seconds * 1000;
  seatTimerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const seatEl = document.querySelector(`.seat[data-seat="${seatNumber}"]`);
    if (!seatEl) return;
    let badge = seatEl.querySelector('.seat-timer');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'seat-timer';
      seatEl.appendChild(badge);
    }
    badge.textContent = remaining + 's';
    badge.classList.toggle('urgent', remaining <= 5);
    if (remaining <= 0) clearSeatTimer();
  }, 200);
}

function clearSeatTimer() {
  if (seatTimerInterval) { clearInterval(seatTimerInterval); seatTimerInterval = null; }
  document.querySelectorAll('.seat-timer').forEach(el => el.remove());
}

// ─── Chip Animation ───────────────────────────────────────────────────────

// ─── Hand Rankings ────────────────────────────────────────────────────────

function openHandRankings() {
  if (document.getElementById('hand-rankings-modal')) return;
  const RANKS = [
    { name: 'Royal Flush',     desc: 'A-K-Q-J-10 of the same suit',       cards: [{rank:'A',suit:'♠'},{rank:'K',suit:'♠'},{rank:'Q',suit:'♠'},{rank:'J',suit:'♠'},{rank:'10',suit:'♠'}] },
    { name: 'Straight Flush',  desc: 'Five consecutive, same suit',        cards: [{rank:'9',suit:'♥'},{rank:'8',suit:'♥'},{rank:'7',suit:'♥'},{rank:'6',suit:'♥'},{rank:'5',suit:'♥'}] },
    { name: 'Four of a Kind',  desc: 'Four cards of the same rank',        cards: [{rank:'A',suit:'♠'},{rank:'A',suit:'♥'},{rank:'A',suit:'♦'},{rank:'A',suit:'♣'},{rank:'K',suit:'♠'}] },
    { name: 'Full House',      desc: 'Three of a kind + a pair',           cards: [{rank:'K',suit:'♠'},{rank:'K',suit:'♥'},{rank:'K',suit:'♦'},{rank:'Q',suit:'♠'},{rank:'Q',suit:'♥'}] },
    { name: 'Flush',           desc: 'Five cards of the same suit',        cards: [{rank:'A',suit:'♥'},{rank:'J',suit:'♥'},{rank:'8',suit:'♥'},{rank:'5',suit:'♥'},{rank:'2',suit:'♥'}] },
    { name: 'Straight',        desc: 'Five consecutive cards, any suit',   cards: [{rank:'9',suit:'♠'},{rank:'8',suit:'♥'},{rank:'7',suit:'♦'},{rank:'6',suit:'♣'},{rank:'5',suit:'♠'}] },
    { name: 'Three of a Kind', desc: 'Three cards of the same rank',       cards: [{rank:'Q',suit:'♠'},{rank:'Q',suit:'♥'},{rank:'Q',suit:'♦'},{rank:'A',suit:'♣'},{rank:'K',suit:'♠'}] },
    { name: 'Two Pair',        desc: 'Two different pairs',                cards: [{rank:'J',suit:'♠'},{rank:'J',suit:'♥'},{rank:'9',suit:'♦'},{rank:'9',suit:'♣'},{rank:'A',suit:'♠'}] },
    { name: 'One Pair',        desc: 'Two cards of the same rank',         cards: [{rank:'A',suit:'♠'},{rank:'A',suit:'♥'},{rank:'K',suit:'♦'},{rank:'Q',suit:'♣'},{rank:'J',suit:'♠'}] },
    { name: 'High Card',       desc: 'Highest card wins',                  cards: [{rank:'A',suit:'♠'},{rank:'K',suit:'♥'},{rank:'Q',suit:'♦'},{rank:'J',suit:'♣'},{rank:'9',suit:'♠'}] },
  ];

  const rows = RANKS.map((r, i) => `
    <div class="hr-row">
      <div class="hr-meta">
        <span class="hr-num">${i + 1}</span>
        <div>
          <div class="hr-name">${r.name}</div>
          <div class="hr-desc">${r.desc}</div>
        </div>
      </div>
      <div class="hr-cards">${r.cards.map(c => cardHtml(c)).join('')}</div>
    </div>`).join('');

  const modal = document.createElement('div');
  modal.id = 'hand-rankings-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal hr-modal" style="max-width:520px;max-height:90vh;overflow-y:auto">
      <h2 style="color:var(--gold);margin:0 0 16px;font-size:1.1rem;display:flex;align-items:center;gap:8px">🃏 Hand Rankings</h2>
      <div class="hr-list">${rows}</div>
      <div class="modal-footer" style="margin-top:16px">
        <button class="btn btn-outline" onclick="document.getElementById('hand-rankings-modal').remove()">Close</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ─── Waitlist helpers ─────────────────────────────────────────────────────

function _showWaitlistOffer() {
  const existing = document.getElementById('waitlist-offer');
  if (existing) return;
  const div = document.createElement('div');
  div.id = 'waitlist-offer';
  div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9010;background:#0a1a12;border:2px solid var(--gold);border-radius:14px;padding:24px 28px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.8);max-width:340px;width:92%';
  div.innerHTML = `
    <div style="font-size:2rem;margin-bottom:8px">🪑</div>
    <h3 style="color:var(--gold);margin:0 0 8px;font-size:1.05rem">Table is Full</h3>
    <p style="color:var(--text-dim);font-size:.86rem;margin:0 0 18px">Join the waiting list and you'll be notified when a seat opens.</p>
    <div style="display:flex;gap:10px;justify-content:center">
      <button class="btn btn-outline" onclick="document.getElementById('waitlist-offer')?.remove()">No thanks</button>
      <button class="btn btn-gold" onclick="waitlistJoin()">📋 Join Waitlist</button>
    </div>`;
  document.body.appendChild(div);
}

function waitlistJoin() {
  document.getElementById('waitlist-offer')?.remove();
  socket?.emit('waitlist:join', { tableId });
}

function waitlistLeave() {
  socket?.emit('waitlist:leave', { tableId });
  document.getElementById('waitlist-banner').style.display = 'none';
  _waitlistState = {};
}

function waitlistJoinNow() {
  document.getElementById('waitlist-banner').style.display = 'none';
  _waitlistState = {};
  // Re-emit join_table — seat should now be open
  socket?.emit('join_table', { tableId, buyInChips: buyIn });
}

function _updateWaitlistBanner() {
  const banner = document.getElementById('waitlist-banner');
  const msgEl  = document.getElementById('waitlist-banner-msg');
  const joinBtn = document.getElementById('waitlist-join-btn');
  if (!banner) return;
  if (!_waitlistState?.active) { banner.style.display = 'none'; return; }
  banner.style.display = '';
  if (msgEl) msgEl.textContent = `You are #${_waitlistState.position} of ${_waitlistState.total} on the waiting list.`;
  if (joinBtn) joinBtn.style.display = _waitlistState.seatAvailable ? '' : 'none';
}

function animateChipToPot(seatNumber, amount = 0) {
  const seatEl = document.querySelector(`.seat[data-seat="${seatNumber}"]`);
  const potEl = document.getElementById('pot-amount');
  if (!seatEl || !potEl) return;

  const seatRect = seatEl.getBoundingClientRect();
  const potRect  = potEl.getBoundingClientRect();

  const denom = CHIP_DENOMS.find(d => amount >= d.value) || CHIP_DENOMS[CHIP_DENOMS.length - 1];
  const chip = document.createElement('div');
  chip.className = 'chip-animate';
  chip.style.left   = (seatRect.left + seatRect.width  / 2 - 8) + 'px';
  chip.style.top    = (seatRect.top  + seatRect.height / 2 - 8) + 'px';
  chip.style.background = denom.bg;
  chip.style.borderColor = denom.border;
  document.body.appendChild(chip);

  requestAnimationFrame(() => {
    chip.style.transform = `translate(${potRect.left + potRect.width / 2 - (seatRect.left + seatRect.width / 2)}px, ${potRect.top + potRect.height / 2 - (seatRect.top + seatRect.height / 2)}px)`;
    chip.style.opacity = '0';
  });

  setTimeout(() => chip.remove(), 700);
}

function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function _updatePauseBanner(isPaused, reason) {
  const banner = document.getElementById('game-paused-banner');
  const reasonEl = document.getElementById('pause-reason-text');
  if (!banner) return;
  banner.style.display = isPaused ? 'block' : 'none';
  if (reasonEl) reasonEl.textContent = reason ? `Reason: ${reason}` : '';
}

// ─── Showdown / Runout helpers ─────────────────────────────────────────────

// Highlight winning seats with gold glow + hand name badge
function _highlightWinners(winners) {
  for (const w of (winners || [])) {
    if (!w.userId || !w.handName) continue;
    const seatBox = document.querySelector(`.seat-box[data-user-id="${w.userId}"]`);
    if (!seatBox) continue;
    seatBox.classList.add('showdown-winner');
    // Add hand name badge
    let badge = seatBox.querySelector('.showdown-hand-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'showdown-hand-badge';
      seatBox.appendChild(badge);
    }
    badge.textContent = w.handName;
  }
}

function _clearShowdownHighlights() {
  document.querySelectorAll('.showdown-winner').forEach(el => el.classList.remove('showdown-winner'));
  document.querySelectorAll('.showdown-hand-badge').forEach(el => el.remove());
}

// Show all hole cards on their seat boxes (all-in runout + showdown reveal)
function _revealAllSeatsCards(allHoleCards) {
  if (!allHoleCards) return;
  for (const [userId, cards] of Object.entries(allHoleCards)) {
    const seatBox = document.querySelector(`.seat-box[data-user-id="${userId}"]`);
    if (!seatBox) continue;
    let cardsEl = seatBox.querySelector('.seat-cards');
    if (!cardsEl) {
      cardsEl = document.createElement('div');
      cardsEl.className = 'seat-cards';
      seatBox.appendChild(cardsEl);
    }
    cardsEl.innerHTML = cards.map(c => cardHtml(c)).join('');
  }
}

// ─── Hand History ──────────────────────────────────────────────────────────

function openHandHistory() {
  document.getElementById('hand-history-modal')?.remove();

  if (!lastHandHistory?.length && !lastHandResult) {
    toast('No hand history yet — play a hand first', 'error');
    return;
  }

  const streets = ['preflop', 'flop', 'turn', 'river'];
  const byStreet = {};
  for (const entry of (lastHandHistory || [])) {
    if (!byStreet[entry.street]) byStreet[entry.street] = [];
    byStreet[entry.street].push(entry);
  }

  const actionLabel = (a) => {
    switch (a.action) {
      case 'post_sb': return `posts SB $${fmt(a.amount)}`;
      case 'post_bb': return `posts BB $${fmt(a.amount)}`;
      case 'fold':    return 'folds';
      case 'check':   return 'checks';
      case 'call':    return `calls $${fmt(a.amount || 0)}`;
      case 'raise':   return `raises to $${fmt(a.amount || 0)}`;
      case 'all_in':  return `goes ALL IN $${fmt(a.amount || 0)}`;
      default:        return a.action;
    }
  };

  let histHtml = '';
  for (const street of streets) {
    const actions = byStreet[street];
    if (!actions?.length) continue;
    histHtml += `<div class="hh-street-header">${street.toUpperCase()}</div>`;
    for (const a of actions) {
      histHtml += `<div class="hh-action"><span class="hh-player">${esc(a.username)}</span> ${actionLabel(a)}</div>`;
    }
  }

  if (lastHandResult) {
    const showdown = (lastHandResult.winners || []).filter(w => w.handName);
    if (showdown.length) {
      histHtml += '<div class="hh-street-header">SHOWDOWN</div>';
      for (const w of lastHandResult.winners || []) {
        const cardsHtml = (w.holeCards || []).map(c => cardHtml(c)).join('');
        histHtml += `<div class="hh-winner"><span class="hh-player">${esc(w.username)}</span>${w.handName ? `<span class="hh-hand-name">${w.handName}</span>` : ''}${cardsHtml}<span class="hh-amount">+$${fmt(w.amount)}</span></div>`;
      }
    } else if (lastHandResult.folded) {
      histHtml += '<div class="hh-street-header">RESULT</div><div class="hh-action">All others folded</div>';
      const w = lastHandResult.winners?.[0];
      if (w) histHtml += `<div class="hh-winner"><span class="hh-player">${esc(w.username)}</span><span class="hh-amount">+$${fmt(w.amount)}</span></div>`;
    }
    if (lastHandResult.potBreakdown?.length > 1) {
      histHtml += `<div class="hh-pots">${lastHandResult.potBreakdown.map(p => `${p.label}: $${fmt(p.amount)}`).join('  •  ')}</div>`;
    }
    if (lastHandResult.rakeCollected) {
      histHtml += `<div style="color:rgba(255,255,255,.4);font-size:.75rem;margin-top:4px">Rake: $${fmt(lastHandResult.rakeCollected)}</div>`;
    }
  }

  const modal = document.createElement('div');
  modal.id = 'hand-history-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:20px 22px;max-width:500px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.8)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="color:var(--gold);margin:0">📋 Hand #${gameState?.handNumber || ''} History</h3>
        <button onclick="document.getElementById('hand-history-modal').remove()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text);border-radius:6px;padding:3px 10px;cursor:pointer">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1;font-size:.85rem">${histHtml || '<div style="color:var(--text-dim);text-align:center;padding:20px">No history for last hand</div>'}</div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ─── Felt Color ───────────────────────────────────────────────────────────────

function applyFeltColor(color) {
  const oval = document.getElementById('poker-oval');
  if (!oval) return;
  // Derive a lighter variant for radial gradient center
  oval.style.background = `radial-gradient(ellipse, ${color}dd 60%, ${color} 100%)`;
}

// ─── Tournament Blind Timer ───────────────────────────────────────────────────

let _blindTimerInterval = null;
let _timerState = null;
let _tournamentId = null;

function updateBlindTimer(state) {
  _timerState = state;
  _tournamentId = state.tournamentId;

  const panel = document.getElementById('blind-timer-panel');
  if (!panel) return;
  panel.style.display = '';
  panel.classList.toggle('paused', !!state.isPaused);

  // Show admin/host controls
  const isHostAdmin = user?.isAdmin || user?.isHost;
  const ctrlEl = document.getElementById('btp-controls');
  const schedWrap = document.getElementById('btp-schedule-btn-wrap');
  if (ctrlEl)   ctrlEl.style.display   = isHostAdmin ? '' : 'none';
  if (schedWrap) schedWrap.style.display = isHostAdmin ? 'none' : '';

  _renderTimerDisplay(state);

  // Start/restart the countdown interval
  if (_blindTimerInterval) clearInterval(_blindTimerInterval);
  if (!state.isPaused) {
    _blindTimerInterval = setInterval(_tickTimer, 500);
  }
}

function _tickTimer() {
  if (!_timerState || _timerState.isPaused) return;
  _timerState.remainingMs = Math.max(0, _timerState.remainingMs - 500);
  _renderTimerDisplay(_timerState);
}

function _renderTimerDisplay(state) {
  const levelEl  = document.getElementById('btp-level');
  const blindsEl = document.getElementById('btp-blinds');
  const countEl  = document.getElementById('btp-countdown');
  const nextEl   = document.getElementById('btp-next');
  const pauseBtn = document.getElementById('btp-pause-btn');

  if (!levelEl) return;

  const rem = Math.max(0, state.remainingMs);
  const mins = Math.floor(rem / 60000);
  const secs = Math.floor((rem % 60000) / 1000).toString().padStart(2, '0');

  levelEl.textContent  = `Level ${state.currentLevel}`;
  blindsEl.textContent = `$${state.smallBlind} / $${state.bigBlind}`;
  countEl.textContent  = state.isPaused ? `${mins}:${secs} ⏸` : `${mins}:${secs}`;
  countEl.classList.toggle('warn', !state.isPaused && rem <= 30_000);

  if (nextEl) {
    nextEl.textContent = state.nextSmallBlind !== undefined
      ? `Next: Level ${state.nextLevel} — $${state.nextSmallBlind}/$${state.nextBigBlind} in ${mins}:${secs}`
      : '';
  }

  if (pauseBtn) {
    pauseBtn.textContent = state.isPaused ? '▶ Resume' : '⏸ Pause';
  }
}

function toggleBlindTimer() {
  if (!_tournamentId) return;
  if (_timerState?.isPaused) {
    socket.emit('tournament_resume_timer', { tournamentId: _tournamentId });
  } else {
    socket.emit('tournament_pause_timer', { tournamentId: _tournamentId });
  }
}

function openBlindSchedule() {
  if (!_timerState?.schedule) return;
  const rows = document.getElementById('blind-sched-rows');
  if (!rows) return;

  rows.innerHTML = `
    <div style="display:grid;grid-template-columns:30px 1fr 1fr 1fr;gap:8px;padding:4px 0;margin-bottom:6px;font-size:.7rem;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)">
      <div>#</div><div>Small / Big</div><div>Duration</div><div></div>
    </div>
    ${_timerState.schedule.map((lvl, i) => {
      const isCurrent = (i + 1) === _timerState.currentLevel;
      const rem = isCurrent ? Math.max(0, _timerState.remainingMs) : null;
      const remStr = rem !== null
        ? `${Math.floor(rem/60000)}:${Math.floor((rem%60000)/1000).toString().padStart(2,'0')}`
        : '';
      return `<div style="display:grid;grid-template-columns:30px 1fr 1fr 1fr;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.82rem${isCurrent?';color:var(--gold);font-weight:700':''}">
        <div>${lvl.level}</div>
        <div>$${lvl.small_blind}/$${lvl.big_blind}</div>
        <div>${lvl.duration_minutes}m</div>
        <div style="font-size:.75rem;color:var(--chip-green)">${remStr ? `⏱ ${remStr}` : ''}</div>
      </div>`;
    }).join('')}`;

  openModal('blind-schedule-modal');
}

// ─── Chat Extras ─────────────────────────────────────────────────────────

function sendChatReaction(emoji) {
  if (!socket) return;
  socket.emit('chat_reaction', { tableId, emoji });
}

function openStickerPicker() {
  let panel = document.getElementById('sticker-panel');
  if (panel) { panel.remove(); return; }
  panel = document.createElement('div');
  panel.id = 'sticker-panel';
  panel.className = 'sticker-panel';
  const stickers = [
    { key: 'nicehd', label: '🤝 Nice Hand' },
    { key: 'onfire', label: '🔥 On Fire' },
    { key: 'bust',   label: '💀 Busted' },
    { key: 'money',  label: '🤑 Money' },
    { key: 'rabbit', label: '🐰 Rabbit' },
    { key: 'cool',   label: '😎 Cool' },
    { key: 'facepalm', label: '🤦 Bad Beat' },
    { key: 'winner', label: '🏆 Winner' },
  ];
  panel.innerHTML = '<div class="stp-title">Stickers</div>' +
    stickers.map(s => `<button class="sticker-pick-btn" onclick="sendSticker('${s.key}')">${s.label}</button>`).join('');
  document.body.appendChild(panel);
  setTimeout(() => document.addEventListener('click', function _sp(e) {
    if (!document.getElementById('sticker-panel')?.contains(e.target)) {
      document.getElementById('sticker-panel')?.remove();
      document.removeEventListener('click', _sp);
    }
  }, { capture: true }), 0);
}

function sendSticker(key) {
  if (!socket) return;
  socket.emit('chat_message', { tableId, message: `__sticker__:${key}` });
  document.getElementById('sticker-panel')?.remove();
}

function sendChatWithReactions() {
  sendChat();
}

function clearChat() {
  if (!socket) return;
  if (!confirm('Clear all chat messages for everyone?')) return;
  socket.emit('chat:clear');
}

function _showReactionFloat(fromUser, emoji) {
  const pot = document.getElementById('pot-amount');
  if (!pot) return;
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.textContent = emoji;
  const rect = pot.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = rect.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ─── Table Stats ─────────────────────────────────────────────────────────

function _renderTableStats() {
  let bar = document.getElementById('table-stats-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'table-stats-bar';
    bar.className = 'table-stats-bar';
    const hdr = document.querySelector('.table-info-bar');
    if (hdr) hdr.parentElement.insertBefore(bar, hdr.nextSibling);
    else document.querySelector('.table-header')?.appendChild(bar);
  }
  if (!_tableStats) { bar.style.display = 'none'; return; }
  const s = _tableStats;
  bar.style.display = '';
  bar.innerHTML =
    `<span>⏱ ${s.handsPerHour}/hr</span>` +
    `<span>🍵 Avg $${fmt(s.avgPot)}</span>` +
    `<span>🏆 Best $${fmt(s.biggestPot)}</span>` +
    `<span style="color:var(--text-dim)">${s.handsPlayed} hands</span>`;
}

// ─── Rabbit Hunt ─────────────────────────────────────────────────────────

function _showRabbitButton() {
  let btn = document.getElementById('rabbit-run-btn');
  if (btn) { btn.style.display = ''; return; }
  btn = document.createElement('button');
  btn.id = 'rabbit-run-btn';
  btn.className = 'btn btn-sm btn-gold rabbit-run-btn';
  btn.textContent = '🐇 Run It';
  btn.onclick = runRabbitHunt;
  const overlay = document.getElementById('hand-result-overlay');
  if (overlay) overlay.querySelector('.hand-result-box')?.appendChild(btn);
  else document.querySelector('.my-cards-area')?.appendChild(btn);
}

function _hideRabbitButton() {
  document.getElementById('rabbit-run-btn')?.remove();
}

function runRabbitHunt() {
  if (!socket || !_rabbitAvailable) return;
  socket.emit('rabbit:run', { tableId });
}

function _showRabbitResult({ cards, foldedCards, communityCards }) {
  const existing = document.getElementById('rabbit-result-overlay');
  if (existing) existing.remove();

  const allCommunity = [...(communityCards || []), ...(cards || [])];
  const communityHtml = allCommunity.map((c, i) => {
    const isRabbit = i >= (communityCards?.length || 0);
    return `<span class="${isRabbit ? 'rabbit-card' : ''}">${cardHtml(c, true)}</span>`;
  }).join('');

  const foldedEntries = Object.values(foldedCards || {});
  const foldedHtml = foldedEntries.length > 0
    ? foldedEntries.map(p => `
        <div class="rabbit-player">
          <span class="rabbit-player-name">${esc(p.username)}</span>
          <div class="rabbit-player-cards">${(p.cards || []).map(c => cardHtml(c, true)).join('')}</div>
        </div>`).join('')
    : '<div style="color:var(--text-dim);font-size:.8rem">No folded cards recorded</div>';

  const div = document.createElement('div');
  div.id = 'rabbit-result-overlay';
  div.className = 'rabbit-result-overlay';
  div.innerHTML = `
    <div class="rabbit-result-box">
      <div class="rabbit-title">🐇 Rabbit Hunt</div>
      <div class="rabbit-community">${communityHtml}</div>
      <div class="rabbit-folded-label">Folded Cards</div>
      <div class="rabbit-folded">${foldedHtml}</div>
      <button class="btn btn-outline" style="margin-top:14px;font-size:.8rem" onclick="document.getElementById('rabbit-result-overlay').remove()">Close</button>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 10000);
}

// ─── Straddle Offer ───────────────────────────────────────────────────────

function _showStraddleOffer(amount, deadline) {
  _dismissStraddleOffer();
  const el = document.createElement('div');
  el.className = 'straddle-offer-prompt';
  el.id = 'straddle-offer-prompt';
  el.innerHTML = `
    <div class="straddle-title">🎯 UTG Straddle?</div>
    <div class="straddle-desc">Post <strong>$${fmt(amount)}</strong> straddle and act last preflop?</div>
    <div class="straddle-cd" id="straddle-offer-cd">8</div>
    <div class="straddle-btns">
      <button class="btn btn-gold" onclick="respondStraddle(true)">Post $${fmt(amount)}</button>
      <button class="btn btn-outline" onclick="respondStraddle(false)">Skip</button>
    </div>`;
  document.body.appendChild(el);
  _straddlePromptEl = el;
  const endTime = deadline;
  _straddleCountdown = setInterval(() => {
    const rem = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const cd = document.getElementById('straddle-offer-cd');
    if (cd) cd.textContent = rem;
    if (rem <= 0) { respondStraddle(false); }
  }, 500);
}

function _dismissStraddleOffer() {
  if (_straddleCountdown) { clearInterval(_straddleCountdown); _straddleCountdown = null; }
  if (_straddlePromptEl)  { _straddlePromptEl.remove(); _straddlePromptEl = null; }
  document.getElementById('straddle-offer-prompt')?.remove();
}

function respondStraddle(accepted) {
  _dismissStraddleOffer();
  if (!socket) return;
  socket.emit('straddle:respond', { tableId, accepted });
}

// ─── Host Control Extras (rabbit hunt toggle, straddle toggle, clear chat) ──

function hostToggleRabbit(enabled) {
  socket?.emit('host:toggle_rabbit', { tableId, enabled });
}

function hostToggleStraddle(enabled) {
  socket?.emit('host:toggle_straddle', { tableId, enabled });
}

// ─── Boot ─────────────────────────────────────────────────────────────────

connect();
