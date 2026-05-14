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

// Raise limits — updated each time it becomes the player's turn
let currentMaxRaise = 0;
let currentMinRaise = 0;

// WebRTC PTT state
let pttStream = null;
const pttPeers = new Map();    // userId -> { pc: RTCPeerConnection, pendingIce: [] }
const pttAudioEls = new Map(); // userId -> HTMLAudioElement
const STUN_CFG = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
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

// ─── Connect ──────────────────────────────────────────────────────────────

function connect() {
  socket = io({ auth: { token: getToken() } });
  window.tableSocket = socket; // expose globally for inline scripts

  socket.on('connect', () => {
    console.log('[socket] connected, socketId:', socket.id, '— emitting join_table for tableId:', tableId);
    socket.emit('join_table', { tableId, buyInChips: buyIn });
    checkMicPermission();
    renderHostControls();
  });

  socket.on('connect_error', (err) => {
    toast(`Connection error: ${err.message}`, 'error');
  });

  socket.on('joined_table', ({ seatNumber, chips }) => {
    toast(`Joined seat ${seatNumber} with ${fmt(chips)} chips`);
    document.getElementById('hdr-chips').textContent = fmt(chips);
  });

  socket.on('game_state', (state) => {
    console.log('[game_state] hand:', state.handActive, 'street:', state.currentStreet, 'players:', state.players?.length, 'currentSeat:', state.currentPlayerSeat);
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
    chatMsg('system', `Hand #${handNumber} started`);
    hideHandResult();
  });

  socket.on('cards_dealt', ({ holeCards }) => {
    renderMyHoleCards(holeCards);
  });

  socket.on('action_required', ({ seatNumber, userId: actingUserId, callAmount, pot }) => {
    console.log('[action_required] seat:', seatNumber, 'userId:', actingUserId, 'callAmt:', callAmount);
    const isMe = actingUserId === user.id;
    if (isMe) toast('Your turn!');
  });

  socket.on('shot_clock_start', ({ userId, seconds, seatNumber }) => {
    if (userId === user.id) startShotClock(seconds);
    startSeatTimer(seatNumber, seconds);
  });

  socket.on('shot_clock_warning', ({ secondsLeft }) => {
    document.querySelector('.shot-clock-fill')?.classList.add('warning');
    toast(`${secondsLeft} seconds left!`, 'error');
  });

  socket.on('street_changed', ({ street, communityCards }) => {
    if (gameState) {
      gameState.currentStreet = street;
      gameState.communityCards = communityCards;
    }
    renderCommunityCards(communityCards);
    document.getElementById('hdr-street').textContent = street.toUpperCase();
    chatMsg('system', `--- ${street.toUpperCase()} ---`);
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

    // Flash rake in pot display before showing winner overlay
    if (result.rakeCollected > 0) {
      const potEl = document.getElementById('pot-amount');
      const potLabel = potEl?.nextElementSibling; // .pot-label
      const origPot = potEl?.textContent;
      if (potEl) {
        potEl.textContent = `🏦 -$${fmt(result.rakeCollected)}`;
        potEl.style.color = 'var(--red)';
        if (potLabel) potLabel.textContent = 'RAKE';
        setTimeout(() => {
          potEl.style.color = '';
          if (potLabel) potLabel.textContent = 'POT';
          showHandResult(result);
        }, 1200);
      } else {
        showHandResult(result);
      }
    } else {
      showHandResult(result);
    }

    if (result.winners?.length) {
      chatMsg('system', `Winner: ${result.winners[0].username} (${result.winners[0].handName || 'folded out'}) +${fmt(result.winners[0].amount)}${result.rakeCollected ? ` | Rake: $${fmt(result.rakeCollected)}` : ''}`);
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
    alert('Message from ' + (data.from || 'Admin') + ': ' + data.message);
    showAdminMessageToast(data.from, data.message, data.pending);
  });
  socket.on('broadcast:message', (data) => {
    console.log('[table] broadcast:message (legacy) received:', data);
    alert('Message from ' + (data.from || 'Admin') + ': ' + data.message);
    showAdminMessageToast(data.from, data.message, data.pending);
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
    toast('Disconnected. Reconnecting…', 'error');
  });

  // ─── WebRTC PTT ─────────────────────────────────────────────────────────

  function pttLog(...args) { console.log('[PTT]', ...args); }
  function pttWarn(...args) { console.warn('[PTT]', ...args); }

  function attachPcDebugHandlers(pc, role, peerId) {
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      pttLog(`ICE connection [${role} → ${peerId}]: ${s}`);
      if (s === 'connected' || s === 'completed') {
        pttLog(`✅ Audio stream ESTABLISHED with ${peerId}`);
      } else if (s === 'failed') {
        pttWarn(`❌ ICE FAILED with ${peerId} — check STUN reachability or firewall`);
      } else if (s === 'disconnected') {
        pttWarn(`⚠️  ICE disconnected from ${peerId} — may recover`);
      }
    };
    pc.onicegatheringstatechange = () => {
      pttLog(`ICE gathering [${role} → ${peerId}]: ${pc.iceGatheringState}`);
    };
    pc.onsignalingstatechange = () => {
      pttLog(`Signaling state [${role} → ${peerId}]: ${pc.signalingState}`);
    };
    pc.onconnectionstatechange = () => {
      pttLog(`Connection state [${role} → ${peerId}]: ${pc.connectionState}`);
    };
  }

  // Server tells speaker which peers to connect to
  socket.on('ptt:peers', async ({ peers }) => {
    if (!pttStream) { pttWarn('ptt:peers received but pttStream is null — ignoring'); return; }
    pttLog(`ptt:peers received — ${peers.length} peer(s):`, peers.map(p => p.username));
    for (const peer of peers) {
      pttLog(`Creating RTCPeerConnection as OFFERER → ${peer.username} (${peer.userId})`);
      const pc = new RTCPeerConnection(STUN_CFG);
      const peerData = { pc, pendingIce: [] };
      pttPeers.set(peer.userId, peerData);
      attachPcDebugHandlers(pc, 'offerer', peer.username);

      const tracks = pttStream.getTracks();
      pttLog(`Adding ${tracks.length} audio track(s) to PC for ${peer.username}`);
      tracks.forEach(t => pc.addTrack(t, pttStream));

      pc.onicecandidate = e => {
        if (e.candidate) {
          const { type, protocol, address } = e.candidate;
          pttLog(`ICE candidate → ${peer.username}: type=${type} proto=${protocol} addr=${address}`);
          socket.emit('ptt:signal', { targetUserId: peer.userId, signal: { type: 'ice', candidate: e.candidate } });
        } else {
          pttLog(`ICE gathering complete for ${peer.username}`);
        }
      };

      try {
        pttLog(`Creating offer for ${peer.username}…`);
        const offer = await pc.createOffer({ offerToReceiveAudio: false });
        await pc.setLocalDescription(offer);
        pttLog(`Offer created (${offer.sdp.split('\n').length} SDP lines) — sending to ${peer.username}`);
        socket.emit('ptt:signal', { targetUserId: peer.userId, signal: { type: 'offer', sdp: offer.sdp } });
      } catch (err) {
        pttWarn(`offer error for ${peer.username}:`, err);
      }
    }
  });

  // Receive WebRTC signaling messages
  socket.on('ptt:signal', async ({ fromUserId, signal }) => {
    pttLog(`ptt:signal received from ${fromUserId} — type: ${signal.type}`);

    if (signal.type === 'offer') {
      pttLog(`Creating RTCPeerConnection as ANSWERER ← ${fromUserId}`);
      const pc = new RTCPeerConnection(STUN_CFG);
      const peerData = { pc, pendingIce: [] };
      pttPeers.set(fromUserId, peerData);
      attachPcDebugHandlers(pc, 'answerer', fromUserId);

      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      pttAudioEls.set(fromUserId, audio);

      pc.ontrack = e => {
        pttLog(`✅ ontrack fired from ${fromUserId} — streams:`, e.streams.length, '— attaching to <audio>');
        audio.srcObject = e.streams[0];
        audio.play().then(() => {
          pttLog(`audio.play() resolved — audio is playing from ${fromUserId}`);
        }).catch(err => {
          pttWarn(`audio.play() rejected for ${fromUserId}:`, err.message, '— browser may require user gesture first');
        });
      };

      pc.onicecandidate = e => {
        if (e.candidate) {
          const { type, protocol, address } = e.candidate;
          pttLog(`ICE candidate ← ${fromUserId}: type=${type} proto=${protocol} addr=${address}`);
          socket.emit('ptt:signal', { targetUserId: fromUserId, signal: { type: 'ice', candidate: e.candidate } });
        } else {
          pttLog(`ICE gathering complete (answerer side) for ${fromUserId}`);
        }
      };

      try {
        pttLog(`setRemoteDescription(offer) from ${fromUserId}`);
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });

        if (peerData.pendingIce.length) {
          pttLog(`Flushing ${peerData.pendingIce.length} buffered ICE candidate(s) for ${fromUserId}`);
          for (const ice of peerData.pendingIce) {
            try { await pc.addIceCandidate(new RTCIceCandidate(ice)); } catch {}
          }
          peerData.pendingIce = [];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        pttLog(`Answer created — sending back to ${fromUserId}`);
        socket.emit('ptt:signal', { targetUserId: fromUserId, signal: { type: 'answer', sdp: answer.sdp } });
      } catch (err) {
        pttWarn(`answer error for ${fromUserId}:`, err);
      }

    } else if (signal.type === 'answer') {
      const peerData = pttPeers.get(fromUserId);
      if (!peerData) { pttWarn(`answer from ${fromUserId} but no peerData — ignoring`); return; }
      const { pc } = peerData;
      pttLog(`setRemoteDescription(answer) from ${fromUserId} — signalingState: ${pc.signalingState}`);
      if (pc.signalingState === 'have-local-offer') {
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          pttLog(`Remote description set (answer) from ${fromUserId}`);
          if (peerData.pendingIce.length) {
            pttLog(`Flushing ${peerData.pendingIce.length} buffered ICE candidate(s) after answer from ${fromUserId}`);
            for (const ice of peerData.pendingIce) {
              try { await pc.addIceCandidate(new RTCIceCandidate(ice)); } catch {}
            }
            peerData.pendingIce = [];
          }
        } catch (err) {
          pttWarn(`setRemoteDescription(answer) error from ${fromUserId}:`, err);
        }
      } else {
        pttWarn(`Unexpected signalingState '${pc.signalingState}' when receiving answer from ${fromUserId} — skipping`);
      }

    } else if (signal.type === 'ice') {
      const peerData = pttPeers.get(fromUserId);
      if (!peerData) { pttWarn(`ICE from ${fromUserId} but no peerData — ignoring`); return; }
      const { pc, pendingIce } = peerData;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        pttLog(`Adding ICE candidate from ${fromUserId} (remoteDescription set)`);
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); }
        catch (err) { pttWarn(`addIceCandidate error from ${fromUserId}:`, err.message); }
      } else {
        pttLog(`Buffering ICE candidate from ${fromUserId} (remoteDescription not yet set)`);
        pendingIce.push(signal.candidate);
      }
    }
  });

  // Visual indicator: someone started/stopped speaking
  socket.on('ptt:speaker_active', ({ userId: speakerId, username: speakerName }) => {
    pttLog(`ptt:speaker_active — ${speakerName} (${speakerId}) started talking`);
    setSpeakingIndicator(speakerId, true, speakerName);
  });

  socket.on('ptt:speaker_stopped', ({ userId: speakerId }) => {
    pttLog(`ptt:speaker_stopped — ${speakerId} stopped talking, closing PC`);
    const peerData = pttPeers.get(speakerId);
    if (peerData) { peerData.pc.close(); pttPeers.delete(speakerId); }
    const audio = pttAudioEls.get(speakerId);
    if (audio) { audio.srcObject = null; audio.remove(); pttAudioEls.delete(speakerId); }
    setSpeakingIndicator(speakerId, false);
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
  if (!allPlayers.length) { panel.style.display = 'none'; return; }
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
}

function renderMyCards(state) {
  const me = state.players?.find(p => p.userId === user.id);
  if (!me || !me.holeCards?.length || me.holeCards[0]?.rank === '?') return;
  renderMyHoleCards(me.holeCards);
}

function renderMyHoleCards(cards) {
  const el = document.getElementById('my-hole-cards');
  if (!cards?.length) return;
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
  shotClockInterval = setInterval(() => {
    const remaining = Math.max(0, shotClockEnd - Date.now()) / 1000;
    const pct = remaining / seconds;
    fill.style.strokeDashoffset = circumference * (1 - pct);
    num.textContent = Math.ceil(remaining);
    if (remaining <= 10) fill.classList.add('warning');
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

  const w = winners[0];
  document.getElementById('hr-winner-name').textContent = w.username;
  document.getElementById('hr-hand-name').textContent = result.folded ? 'Everyone folded' : (w.handName || '');
  document.getElementById('hr-amount').textContent = `+$${fmt(w.amount)}`;
  document.getElementById('hr-cards').innerHTML =
    (w.holeCards || []).map(c => cardHtml(c, true)).join('');
  const rakeEl = document.getElementById('hr-rake');
  if (rakeEl && result.rakeCollected) {
    rakeEl.textContent = `Rake: $${fmt(result.rakeCollected)}`;
  } else if (rakeEl) {
    rakeEl.textContent = '';
  }

  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 4000);
}

function hideHandResult() {
  document.getElementById('hand-result-overlay').classList.add('hidden');
}

// ─── Jackpot ──────────────────────────────────────────────────────────────

function updateJackpotDisplay(data) {
  document.getElementById('hdr-jackpot').textContent = `🏆 $${fmt(data.amount)}`;
  const min = data.timerRemainingMin || 0;
  document.getElementById('hdr-jackpot-timer').textContent = `${min}m left`;
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

function showAdminMessageToast(from, message, pending) {
  const existing = document.getElementById('admin-msg-overlay');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'admin-msg-overlay';
  div.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9500;max-width:360px;width:90%;background:#0a1a12;border:2px solid var(--gold);border-radius:12px;padding:16px 20px;box-shadow:0 8px 32px rgba(0,0,0,.6)';
  div.innerHTML = `
    <div style="font-size:.72rem;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">📨 ${pending ? 'Missed message' : 'Message from Admin'} — ${from}</div>
    <div style="color:var(--text);font-size:.9rem;line-height:1.5">${String(message).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</div>
    <button onclick="document.getElementById('admin-msg-overlay').remove()" style="margin-top:10px;background:none;border:1px solid var(--gold);color:var(--gold);padding:3px 12px;border-radius:6px;cursor:pointer;font-size:.78rem">Dismiss</button>`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 15000);
}

// ─── Push to Talk ─────────────────────────────────────────────────────────

async function startPTT(e) {
  if (e) e.preventDefault();
  if (pttStream) return;
  console.log('[PTT] startPTT() called — requesting microphone…');
  try {
    pttStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const tracks = pttStream.getAudioTracks();
    console.log('[PTT] Mic acquired:', tracks.map(t => `"${t.label}" enabled=${t.enabled} muted=${t.muted}`));
    const btn = document.getElementById('ptt-btn');
    btn.classList.add('speaking');
    btn.textContent = '🔴 Talking…';
    console.log('[PTT] Emitting ptt:join to server');
    socket.emit('ptt:join');
  } catch (err) {
    console.error('[PTT] getUserMedia error:', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      toast('Microphone blocked — allow access in browser settings', 'error');
      showMicDeniedBanner();
    } else {
      toast('Microphone error: ' + err.message, 'error');
    }
  }
}

async function checkMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    console.log('[PTT] Mic permission state:', status.state);
    if (status.state === 'denied') showMicDeniedBanner();
    status.onchange = () => console.log('[PTT] Mic permission changed to:', status.state);
  } catch {}
}

function showMicDeniedBanner() {
  if (document.getElementById('mic-denied-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'mic-denied-banner';
  banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#e63946;color:#fff;padding:10px 18px;border-radius:8px;z-index:9999;font-size:.9rem;text-align:center';
  banner.textContent = '🎙 Microphone access denied. Click the camera/mic icon in your browser address bar to allow.';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 8000);
}

function stopPTT() {
  if (!pttStream) return;
  console.log('[PTT] stopPTT() — stopping tracks, closing', pttPeers.size, 'peer connection(s)');
  pttStream.getTracks().forEach(t => t.stop());
  pttStream = null;
  const btn = document.getElementById('ptt-btn');
  btn.classList.remove('speaking');
  btn.textContent = '🎙 Hold to Talk';
  pttPeers.forEach(({ pc }, uid) => { console.log('[PTT] Closing PC for', uid); pc.close(); });
  pttPeers.clear();
  pttAudioEls.forEach(a => { a.srcObject = null; a.remove(); });
  pttAudioEls.clear();
  socket.emit('ptt:stop');
  document.querySelectorAll('.ptt-speaking').forEach(el => el.remove());
  console.log('[PTT] ptt:stop emitted, all peers cleared');
}

// ─── Mic Test (loopback with volume meter) ────────────────────────────────

let _micTestStream = null;
let _micTestCtx = null;

async function testMic() {
  // If test is already running, close it
  if (_micTestStream) { closeMicTest(); return; }

  const btn = document.getElementById('mic-test-btn');
  if (btn) { btn.textContent = '⏳ Testing…'; btn.disabled = true; }

  console.log('[MIC TEST] Requesting microphone for loopback test…');
  try {
    // echoCancellation OFF so you actually hear yourself
    _micTestStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    const track = _micTestStream.getAudioTracks()[0];
    console.log('[MIC TEST] Stream acquired — track:', track.label, '| settings:', JSON.stringify(track.getSettings()));

    _micTestCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _micTestCtx.createMediaStreamSource(_micTestStream);

    // Analyser for level meter
    const analyser = _micTestCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    // Short delay to break feedback loop (speakers → mic)
    const delay = _micTestCtx.createDelay(1.0);
    delay.delayTime.value = 0.25;
    source.connect(delay);
    delay.connect(_micTestCtx.destination);

    console.log('[MIC TEST] AudioContext state:', _micTestCtx.state, '— loopback active (250ms delay)');
    showMicTestUI(analyser);
    if (btn) { btn.textContent = '🔴 Stop Test'; btn.disabled = false; }
  } catch (err) {
    console.error('[MIC TEST] Failed:', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      toast('Microphone blocked — allow access in browser settings', 'error');
      showMicDeniedBanner();
    } else {
      toast('Mic error: ' + err.message, 'error');
    }
    if (btn) { btn.textContent = '🎚 Mic'; btn.disabled = false; }
  }
}

function showMicTestUI(analyser) {
  const existing = document.getElementById('mic-test-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'mic-test-panel';
  panel.style.cssText = [
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%)',
    'background:#0a1a12;border:2px solid var(--gold);border-radius:16px',
    'padding:24px 28px;z-index:9999;text-align:center;min-width:300px',
    'box-shadow:0 8px 40px rgba(0,0,0,.8)'
  ].join(';');
  panel.innerHTML = `
    <div style="font-size:2rem;margin-bottom:6px">🎙</div>
    <div style="color:var(--gold);font-weight:700;font-size:1.05rem;margin-bottom:4px">Mic Test — Loopback Active</div>
    <div style="color:rgba(255,255,255,.5);font-size:.8rem;margin-bottom:18px">
      Speak into your mic — you'll hear yourself after a 250ms delay.<br>
      Watch the level bar below for signal.
    </div>
    <canvas id="mic-level-canvas" width="260" height="36"
      style="display:block;margin:0 auto 10px;border-radius:8px;background:rgba(0,0,0,.4)"></canvas>
    <div id="mic-level-label" style="font-family:monospace;font-size:.78rem;color:var(--chip-green);margin-bottom:20px">
      Level: –
    </div>
    <div style="display:flex;gap:10px;justify-content:center">
      <button onclick="closeMicTest()" class="btn btn-outline" style="flex:1">Stop Test</button>
      <button onclick="closeMicTest();startPTT()" class="btn btn-gold" style="flex:1">✅ Mic OK — Talk</button>
    </div>`;
  document.body.appendChild(panel);

  const canvas = document.getElementById('mic-level-canvas');
  const ctx = canvas.getContext('2d');
  const bufLen = analyser.frequencyBinCount;
  const timeData = new Uint8Array(bufLen);

  let rafId;
  function draw() {
    rafId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(timeData);

    // RMS amplitude
    let sum = 0;
    for (let i = 0; i < bufLen; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / bufLen);
    const level = Math.min(1, rms * 4); // scale up for visibility

    // Draw meter bar
    ctx.clearRect(0, 0, 260, 36);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fillRect(0, 0, 260, 36);
    const barW = level * 260;
    const hue = level < 0.6 ? 120 : level < 0.85 ? 60 : 0;
    ctx.fillStyle = `hsl(${hue},80%,48%)`;
    ctx.fillRect(0, 6, barW, 24);

    // Threshold marker at -18 dBFS ≈ 0.126 RMS scaled → ~13%
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.beginPath(); ctx.moveTo(34, 4); ctx.lineTo(34, 32); ctx.stroke();

    const pct = Math.round(level * 100);
    const label = document.getElementById('mic-level-label');
    if (label) {
      label.textContent = `Level: ${pct}% ${level > 0.04 ? '🟢 Signal detected' : '🔴 No signal — speak or check mic'}`;
      label.style.color = level > 0.04 ? 'var(--chip-green)' : '#e63946';
    }
  }
  draw();
  panel._stopMeter = () => cancelAnimationFrame(rafId);
}

function closeMicTest() {
  const panel = document.getElementById('mic-test-panel');
  if (panel) {
    if (panel._stopMeter) panel._stopMeter();
    panel.remove();
  }
  if (_micTestStream) {
    _micTestStream.getTracks().forEach(t => t.stop());
    _micTestStream = null;
    console.log('[MIC TEST] Stream stopped');
  }
  if (_micTestCtx) {
    _micTestCtx.close();
    _micTestCtx = null;
  }
  const btn = document.getElementById('mic-test-btn');
  if (btn) { btn.textContent = '🎚 Mic'; btn.disabled = false; }
}

function setSpeakingIndicator(userId, active, username) {
  const seatBox = document.querySelector(`.seat-box[data-user-id="${userId}"]`);
  if (!seatBox) {
    if (active) toast(`🎙 ${username || 'Player'} is talking`);
    return;
  }
  const nameEl = seatBox.querySelector('.seat-name');
  const existing = seatBox.querySelector('.ptt-speaking');
  if (active && !existing) {
    const dot = document.createElement('span');
    dot.className = 'ptt-speaking';
    dot.title = 'Speaking';
    if (nameEl) nameEl.appendChild(dot);
    else seatBox.appendChild(dot);
  } else if (!active && existing) {
    existing.remove();
  }
}

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

// ─── Boot ─────────────────────────────────────────────────────────────────

connect();
