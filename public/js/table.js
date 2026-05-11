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

// WebRTC PTT state
let pttStream = null;
const pttPeers = new Map();   // userId -> RTCPeerConnection
const pttAudioEls = new Map(); // userId -> HTMLAudioElement
const STUN_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

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

  socket.on('connect', () => {
    socket.emit('join_table', { tableId, buyInChips: buyIn });
  });

  socket.on('connect_error', (err) => {
    toast(`Connection error: ${err.message}`, 'error');
  });

  socket.on('joined_table', ({ seatNumber, chips }) => {
    toast(`Joined seat ${seatNumber} with ${fmt(chips)} chips`);
    document.getElementById('hdr-chips').textContent = fmt(chips);
  });

  socket.on('game_state', (state) => {
    gameState = state;
    renderTable(state);
    updateHeader(state);
  });

  socket.on('my_state', (state) => {
    myState = state;
    renderMyCards(state);
    updateActionButtons(state);
  });

  socket.on('hand_started', ({ handNumber, dealerSeat }) => {
    chatMsg('system', `Hand #${handNumber} started`);
    hideHandResult();
  });

  socket.on('cards_dealt', ({ holeCards }) => {
    renderMyHoleCards(holeCards);
  });

  socket.on('action_required', ({ seatNumber, userId, callAmount, pot }) => {
    const isMe = userId === user.id;
    if (isMe) toast('Your turn!');
  });

  socket.on('shot_clock_start', ({ userId, seconds, seatNumber }) => {
    if (userId === user.id) startShotClock(seconds);
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

  socket.on('hand_ended', (result) => {
    stopShotClock();
    showHandResult(result);
    if (result.winners?.length) {
      chatMsg('system', `Winner: ${result.winners[0].username} (${result.winners[0].handName || 'folded out'}) +${fmt(result.winners[0].amount)}`);
    }
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

  // Server tells speaker which peers to connect to
  socket.on('ptt:peers', async ({ peers }) => {
    if (!pttStream) return;
    for (const peer of peers) {
      const pc = new RTCPeerConnection(STUN_CFG);
      pttPeers.set(peer.userId, pc);
      pttStream.getTracks().forEach(t => pc.addTrack(t, pttStream));
      pc.onicecandidate = e => {
        if (e.candidate) socket.emit('ptt:signal', { targetUserId: peer.userId, signal: { type: 'ice', candidate: e.candidate } });
      };
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('ptt:signal', { targetUserId: peer.userId, signal: { type: 'offer', sdp: offer.sdp } });
      } catch {}
    }
  });

  // Receive WebRTC signaling messages
  socket.on('ptt:signal', async ({ fromUserId, signal }) => {
    if (signal.type === 'offer') {
      // We are a listener — someone is sending us audio
      const pc = new RTCPeerConnection(STUN_CFG);
      pttPeers.set(fromUserId, pc);
      const audio = new Audio();
      audio.autoplay = true;
      document.body.appendChild(audio);
      pttAudioEls.set(fromUserId, audio);
      pc.ontrack = e => { audio.srcObject = e.streams[0]; };
      pc.onicecandidate = e => {
        if (e.candidate) socket.emit('ptt:signal', { targetUserId: fromUserId, signal: { type: 'ice', candidate: e.candidate } });
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('ptt:signal', { targetUserId: fromUserId, signal: { type: 'answer', sdp: answer.sdp } });
      } catch {}
    } else if (signal.type === 'answer') {
      const pc = pttPeers.get(fromUserId);
      if (pc && pc.signalingState !== 'stable') {
        try { await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }); } catch {}
      }
    } else if (signal.type === 'ice') {
      const pc = pttPeers.get(fromUserId);
      if (pc && signal.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
      }
    }
  });

  // Visual indicator: someone started/stopped speaking
  socket.on('ptt:speaker_active', ({ userId: speakerId, username: speakerName }) => {
    setSpeakingIndicator(speakerId, true, speakerName);
  });

  socket.on('ptt:speaker_stopped', ({ userId: speakerId }) => {
    const pc = pttPeers.get(speakerId);
    if (pc) { pc.close(); pttPeers.delete(speakerId); }
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
      const holeCardsHtml = player.holeCards?.length
        ? player.holeCards.map(c => c.rank === '?' ? '<div class="card back"></div>' : cardHtml(c)).join('')
        : '';

      html += `
        <div class="seat" style="left:${pos.x}%;top:${pos.y}%">
          <div class="seat-box ${isActive ? 'active-player' : ''} ${player.hasFolded ? 'folded' : ''} ${player.isSittingOut ? 'sitting-out' : ''} ${isMe ? 'me' : ''}" data-user-id="${player.userId}">
            ${isDealer ? '<div class="dealer-puck">D</div>' : ''}
            <div class="seat-name" title="${esc(player.username)}">${esc(player.username)}${isMe ? ' (You)' : ''}</div>
            <div class="seat-chips">${fmt(player.chips)}</div>
            <div class="seat-bet">${player.currentBet ? '+$' + fmt(player.currentBet) : ''}</div>
            ${holeCardsHtml ? `<div class="seat-cards">${holeCardsHtml}</div>` : ''}
            ${player.isSittingOut ? '<div style="color:#888;font-size:.65rem">away</div>' : ''}
            ${player.isAllIn ? '<div style="color:var(--red);font-size:.65rem;font-weight:bold">ALL IN</div>' : ''}
          </div>
        </div>`;
    } else {
      html += `
        <div class="seat" style="left:${pos.x}%;top:${pos.y}%">
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
  const callAmountEl = document.getElementById('call-amount');
  const raiseSlider = document.getElementById('raise-slider');
  const raiseInput = document.getElementById('raise-input');

  btnFold.disabled = !isMyTurn;
  btnCheck.disabled = !isMyTurn || !state.canCheck;
  btnCall.disabled = !isMyTurn || state.canCheck;
  btnRaise.disabled = !isMyTurn;

  if (isMyTurn) {
    const callAmt = state.callAmount || 0;
    callAmountEl.textContent = callAmt ? `$${fmt(callAmt)}` : '';

    const min = state.minRaiseAmount || 0;
    const max = state.maxRaiseAmount || 0;
    raiseSlider.min = min;
    raiseSlider.max = max;
    raiseSlider.value = min;
    raiseInput.value = min;
    raiseInput.min = min;
    raiseInput.max = max;
    updateRaiseDisplay();

    if (state.potLimitMax) {
      // PLO indicator
      document.getElementById('raise-display').textContent = `up to $${fmt(state.potLimitMax)}`;
    }
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
    amount = parseInt(document.getElementById('raise-input').value);
    if (!amount) return toast('Enter raise amount', 'error');
  }
  socket.emit('player_action', { tableId, action, amount });
}

function onRaiseSlider() {
  const v = document.getElementById('raise-slider').value;
  document.getElementById('raise-input').value = v;
  updateRaiseDisplay();
}

function onRaiseInput() {
  const v = document.getElementById('raise-input').value;
  document.getElementById('raise-slider').value = v;
  updateRaiseDisplay();
}

function updateRaiseDisplay() {
  const v = document.getElementById('raise-input').value;
  document.getElementById('raise-display').textContent = v ? `$${fmt(v)}` : '–';
}

function requestBreak() {
  socket.emit('request_break', { tableId });
}

function returnFromBreak() {
  socket.emit('return_from_break', { tableId });
}

function leaveTable() {
  socket.emit('leave_table', { tableId });
  window.location.href = '/lobby.html';
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
  return `<div class="card ${isRed ? 'red' : 'black'} ${large ? 'large' : ''} ${appear ? 'card-appear' : ''}">
    <div class="rank">${card.rank}</div>
    <div class="suit">${card.suit}</div>
  </div>`;
}

function fmt(n) { return Number(n).toLocaleString(); }
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

const toastContainer = document.getElementById('toast-container');
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── Push to Talk ─────────────────────────────────────────────────────────

async function startPTT(e) {
  if (e) e.preventDefault();
  if (pttStream) return;
  try {
    pttStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    document.getElementById('ptt-btn').classList.add('speaking');
    socket.emit('ptt:join');
  } catch {
    toast('Microphone access denied', 'error');
  }
}

function stopPTT() {
  if (!pttStream) return;
  pttStream.getTracks().forEach(t => t.stop());
  pttStream = null;
  document.getElementById('ptt-btn').classList.remove('speaking');
  pttPeers.forEach(pc => pc.close());
  pttPeers.clear();
  pttAudioEls.forEach(a => { a.srcObject = null; a.remove(); });
  pttAudioEls.clear();
  socket.emit('ptt:stop');
  document.querySelectorAll('.ptt-speaking').forEach(el => el.remove());
}

function setSpeakingIndicator(userId, active, username) {
  // Try to find the seat for this user
  const seatBox = document.querySelector(`.seat-box[data-user-id="${userId}"]`);
  if (!seatBox) {
    if (active) toast(`🎙 ${username || 'Player'} is talking`);
    return;
  }
  const existing = seatBox.querySelector('.ptt-speaking');
  if (active && !existing) {
    const dot = document.createElement('span');
    dot.className = 'ptt-speaking';
    dot.textContent = '🎙';
    seatBox.appendChild(dot);
  } else if (!active && existing) {
    existing.remove();
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────

connect();
