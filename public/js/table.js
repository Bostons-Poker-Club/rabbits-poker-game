'use strict';

requireAuth();

const user = getUser();
const params = new URLSearchParams(location.search);
const tableId = params.get('tableId');
const buyIn = parseInt(params.get('buyIn')) || 200;

if (!tableId) window.location.href = '/lobby.html';

let socket = null;
let gameState = null;
let myState = null;
let shotClockInterval = null;
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

(function initOrientation() {
  // Try to lock to landscape — works on Android Chrome and installed PWAs
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }

  function checkOrientation() {
    const overlay = document.getElementById('rotate-overlay');
    if (!overlay) return;
    const isPortrait = window.innerHeight > window.innerWidth;
    const isMobile = Math.min(window.innerWidth, window.innerHeight) <= 500;
    overlay.style.display = (isPortrait && isMobile) ? 'flex' : 'none';
  }

  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', checkOrientation);
  checkOrientation();
})();

// Initialise sound engine (reads mute preference from localStorage)
if (window.Sound) Sound.init();

// ─── Connect ──────────────────────────────────────────────────────────────

function connect() {
  socket = io({ auth: { token: getToken() } });
  window.tableSocket = socket; // expose globally for inline scripts

  socket.on('connect', () => {
    console.log('[socket] connected, socketId:', socket.id, '— emitting join_table for tableId:', tableId);
    document.getElementById('reconnecting-banner').style.display = 'none';
    socket.emit('join_table', { tableId, buyInChips: buyIn });
    checkMicPermission();
    renderHostControls();
  });

  socket.on('connect_error', (err) => {
    toast(`Connection error: ${err.message}`, 'error');
  });

  socket.on('joined_table', ({ seatNumber, chips, tableName }) => {
    toast(`Joined seat ${seatNumber} with ${fmt(chips)} chips`);
    document.getElementById('hdr-chips').textContent = fmt(chips);
    if (tableName) document.getElementById('hdr-table-name').textContent = tableName;
    // Show High Hand submit button for hosts and admins
    if (user?.isHost || user?.isAdmin) {
      const hhBtn = document.getElementById('host-hh-btn');
      if (hhBtn) hhBtn.style.display = '';
    }
    _pttInit();
    _showCamPrompt();
  });

  socket.on('game_state', (state) => {
    console.log('[game_state] hand:', state.handActive, 'street:', state.currentStreet, 'players:', state.players?.length, 'seat:', state.currentPlayerSeat, 'pot:', state.pot);
    // Detect new bets for chip animation before re-render
    if (state.players) {
      for (const p of state.players) {
        const prev = prevBets[p.seatNumber] || 0;
        if (p.currentBet > prev && !p.hasFolded) {
          animateChipToPot(p.seatNumber);
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
  });

  socket.on('my_state', (state) => {
    myState = state;
    renderMyCards(state);
    updateActionButtons(state);
  });

  socket.on('hand_started', ({ handNumber, dealerSeat }) => {
    console.log('[hand_started] hand:', handNumber, 'dealer seat:', dealerSeat);
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
    const isMe = actingUserId === user.id;
    if (isMe) {
      toast('Your turn!');
      if (window.Sound) Sound.notification();
    }
  });

  socket.on('player_acted', ({ action, amount, username: actorName, isAllIn }) => {
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
    stopShotClock();
    clearSeatTimer();
    prevBets = {};
    currentRunoutCards = null; // clear runout overlay
    lastHandHistory = result.history || [];
    lastHandResult = result;
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

  socket.on('jackpot_state', (data) => {
    updateJackpotDisplay(data);
  });

  socket.on('jackpot_won', ({ amount, message }) => {
    toast(`🏆 ${message}`, 'jackpot');
  });

  socket.on('jackpot_awarded', ({ amount, winnerId }) => {
    if (winnerId) chatMsg('system', `🏆 JACKPOT AWARDED: $${amount}`);
  });

  socket.on('blind_increase', ({ blindLevel, small_blind, big_blind }) => {
    toast(`Blinds increased to $${small_blind}/$${big_blind} (Level ${blindLevel})`);
    chatMsg('system', `Blinds: $${small_blind}/$${big_blind}`);
  });

  socket.on('chat', ({ username, message }) => {
    chatMsg(username, message);
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
  });

  socket.on('disconnect', () => {
    document.getElementById('reconnecting-banner').style.display = 'block';
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

  const others = allPlayers.filter(p => p.userId !== user.id);

  // Player chip controls
  document.getElementById('host-player-list').innerHTML = others.map(p => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.07)">
      <span style="color:var(--text)">${esc(p.username)}</span>
      <span style="color:var(--chip-green);font-size:.7rem">${fmt(p.chips)}</span>
      <button class="btn btn-sm btn-gold" style="padding:2px 7px;font-size:.7rem" onclick="hostAddChips('${p.userId}','${esc(p.username)}')">+Chips</button>
    </div>`).join('') +
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
    </div>`;

  // Admin Mic Controls (dedicated panel, top-left)
  if (u?.isAdmin) renderAdminPttPanel(allPlayers);
}

function hostAddChips(targetUserId, username) {
  const amt = parseInt(prompt(`Add chips for ${username}:`, '500'));
  if (!amt || amt <= 0) return;
  socket.emit('host:add_chips', { targetUserId, amount: amt });
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
      const holeCardsHtml = player.holeCards?.length
        ? player.holeCards.map(c => c.rank === '?' ? '<div class="card back"></div>' : cardHtml(c)).join('')
        : '';

      html += `
        <div class="seat" data-seat="${seatNum}" style="left:${pos.x}%;top:${pos.y}%">
          <div class="seat-box ${isActive ? 'active-player' : ''} ${player.hasFolded ? 'folded' : ''} ${player.isSittingOut ? 'sitting-out' : ''} ${isMe ? 'me' : ''}" data-user-id="${player.userId}">
            ${isDealer ? '<div class="dealer-puck">D</div>' : ''}
            ${hasPuck ? `<div class="money-puck">💰 $${fmt(moneyPuck.value)}</div>` : ''}
            <div class="seat-avatar" data-cam-uid="${player.userId}"><div class="seat-initials">${esc(player.username).charAt(0).toUpperCase()}</div></div>
            <div class="seat-name" title="${esc(player.username)}">${esc(player.username)}${isMe ? ' (You)' : ''}</div>
            <div class="seat-chips" style="font-weight:700;color:var(--chip-green)">${player.chips > 0 ? `🪙 ${fmt(player.chips)}` : '<span style="color:var(--red)">🪙 0 – Rebuy?</span>'}</div>
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

  if (isMyTurn) {
    const callAmt = state.callAmount || 0;
    callAmountEl.textContent = callAmt ? `$${fmt(callAmt)}` : '';

    const min = state.minRaiseAmount || 0;
    const max = state.maxRaiseAmount || 0;  // always = player.chips + player.currentBet
    currentMinRaise = min;
    currentMaxRaise = max;

    // Set slider bounds to exact chip stack
    raiseSlider.min = min;
    raiseSlider.max = max;
    raiseSlider.value = min;
    raiseInput.value = min;
    raiseInput.min = min;
    raiseInput.max = max;
    updateRaiseDisplay();

    if (state.potLimitMax) {
      // PLO: show pot-limit cap but still enforce chip stack
      document.getElementById('raise-display').textContent = `up to $${fmt(Math.min(state.potLimitMax, max))}`;
    }
  } else {
    // Not our turn — reset limits so stale values don't leak into validation
    currentMinRaise = 0;
    currentMaxRaise = 0;
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

function chatMsg(name, text) {
  const el = document.getElementById('chat-messages');
  const isSystem = name === 'system';
  const div = document.createElement('div');
  div.className = `chat-msg ${isSystem ? 'system' : ''}`;
  div.innerHTML = isSystem
    ? `<span class="chat-text">${esc(text)}</span>`
    : `<span class="chat-name">${esc(name)}:</span> <span class="chat-text">${esc(text)}</span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
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
  const isRed = card.suit === '♥' || card.suit === '♦';
  const label = `${card.rank}${card.suit}`;
  return `<div class="card ${isRed ? 'red' : 'black'} ${large ? 'large' : ''} ${appear ? 'card-appear' : ''}" title="${label}">
    <div class="rank">${card.rank}</div>
    <div class="suit">${card.suit}</div>
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
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
      audio: false
    });
    camEnabled = true;
    const [videoTrack] = camStream.getVideoTracks();
    // Push video track to all existing peer connections
    for (const [peerId, pc] of pttPeers) {
      const sender = _getCamVideoSender(pc);
      if (sender) {
        try { await sender.replaceTrack(videoTrack); } catch {}
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
    const avatarEl = document.querySelector(`.seat-avatar[data-cam-uid="${uid}"]`);
    if (!avatarEl) continue;
    if (enabled) _setAvatarVideo(avatarEl, stream, false);
    else _clearAvatarVideo(avatarEl);
  }
}

function _setAvatarVideo(avatarEl, stream, muted) {
  avatarEl.classList.add('has-video');
  let vid = avatarEl.querySelector('video');
  if (!vid) {
    vid = document.createElement('video');
    vid.className = 'seat-cam-video';
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = muted;
    vid.onclick = () => _expandCamVideo(vid, avatarEl.dataset.camUid);
    avatarEl.appendChild(vid);
  }
  if (vid.srcObject !== stream) vid.srcObject = stream;
  vid.play().catch(() => {});
}

function _clearAvatarVideo(avatarEl) {
  avatarEl.classList.remove('has-video');
  const vid = avatarEl.querySelector('video');
  if (vid) { vid.srcObject = null; vid.remove(); }
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
  if (camStream || sessionStorage.getItem('rp_cam_skip')) return;
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
      console.log(`[CAM] video track from ${peerId}`);
      peerCamStreams.set(peerId, stream);
      _updateSeatVideos();
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

function animateChipToPot(seatNumber) {
  const seatEl = document.querySelector(`.seat[data-seat="${seatNumber}"]`);
  const potEl = document.getElementById('pot-amount');
  if (!seatEl || !potEl) return;

  const seatRect = seatEl.getBoundingClientRect();
  const potRect = potEl.getBoundingClientRect();

  const chip = document.createElement('div');
  chip.className = 'chip-animate';
  chip.textContent = '🪙';
  chip.style.left = (seatRect.left + seatRect.width / 2) + 'px';
  chip.style.top = (seatRect.top + seatRect.height / 2) + 'px';
  document.body.appendChild(chip);

  requestAnimationFrame(() => {
    chip.style.transform = `translate(${potRect.left + potRect.width / 2 - (seatRect.left + seatRect.width / 2)}px, ${potRect.top + potRect.height / 2 - (seatRect.top + seatRect.height / 2)}px)`;
    chip.style.opacity = '0';
  });

  setTimeout(() => chip.remove(), 700);
}

function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

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

// ─── Boot ─────────────────────────────────────────────────────────────────

connect();
