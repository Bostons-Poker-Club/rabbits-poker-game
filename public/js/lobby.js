'use strict';

requireAuth();

const user = getUser();
let jackpotTimerInterval = null;
let jackpotData = null;
let inboxMessages = [];
const INBOX_READ_KEY = 'rp_inbox_read_at';

// ─── Init ─────────────────────────────────────────────────────────────────

document.getElementById('header-username').textContent = user.username;
document.getElementById('header-chips').textContent = user.isAdmin
  ? `♛ ${fmtChips(user.chips || 0)}`
  : fmtChips(user.chips);

function applyRoleUI(isAdmin, isHost) {
  if (isAdmin) {
    document.getElementById('admin-link').style.display = '';
    document.getElementById('create-table-btn').style.display = '';
    document.getElementById('create-tournament-btn').style.display = '';
    const banner = document.getElementById('host-request-banner');
    if (banner) banner.style.display = 'none';
  } else if (isHost) {
    const btn = document.getElementById('create-table-btn');
    if (btn) { btn.style.display = ''; btn.textContent = '📋 Request Table'; }
    const banner = document.getElementById('host-request-banner');
    if (banner) banner.style.display = '';
  }
}

// Apply immediately from cached user (JWT-derived)
applyRoleUI(user.isAdmin, false);

// Then confirm from API in case localStorage is stale
apiFetch('/api/profile').then(profile => {
  const isAdmin = !!(profile.is_admin || profile.isAdmin);
  const isHost = !!(profile.is_host);
  applyRoleUI(isAdmin, isHost);
  const u = getUser();
  if (u) { u.isAdmin = isAdmin; u.isHost = isHost; u.chips = profile.chips; sessionStorage.setItem('rp_user', JSON.stringify(u)); }
  // Always show actual chip count so admin can join tables
  document.getElementById('header-chips').textContent = isAdmin
    ? `♛ ${fmtChips(profile.chips)}`
    : fmtChips(profile.chips);
  if (isHost && !isAdmin) {
    const badge = document.getElementById('host-badge');
    if (badge) badge.style.display = '';
  }
}).catch(() => {});

loadTables();
loadTournaments();
loadJackpot();
loadInbox();

// ─── Socket (notifications for all logged-in users) ───────────────────────

let lobbySocket = null;
if (typeof io !== 'undefined') {
  lobbySocket = io({ auth: { token: sessionStorage.getItem('rp_token') } });
  window.lobbySocket = lobbySocket; // expose globally for inline scripts
  lobbySocket.on('connect', () => {
    document.getElementById('reconnecting-banner').style.display = 'none';
    lobbySocket.emit('lobby:join');
  });
  lobbySocket.on('disconnect', () => {
    document.getElementById('reconnecting-banner').style.display = 'block';
  });

  // Admin-only events
  if (user.isAdmin) {
    lobbySocket.on('admin:new_player', ({ username }) => {
      showToast(`🔔 New registration: ${username} — check Pending Players in Admin`, 'success');
    });
    lobbySocket.on('admin:player_in_lobby', ({ username }) => {
      showToast(`🎯 ${username} is in the lobby`);
    });
  }

  // Host/player events
  lobbySocket.on('you:host_granted', ({ message }) => {
    showHostModal('granted', message);
    setTimeout(() => location.reload(), 4000);
  });
  lobbySocket.on('you:host_revoked', ({ message }) => {
    showToast(message);
    setTimeout(() => location.reload(), 1500);
  });
  lobbySocket.on('chips_received', ({ amount, from }) => {
    showToast(`🪙 ${fmtChips(amount)} chips added by ${from}`);
    setTimeout(refreshChips, 500);
  });

  // Table request responses
  lobbySocket.on('table:request_submitted', () => {
    showToast('✅ Request sent to admin — you\'ll be notified when it\'s approved');
  });
  lobbySocket.on('table:request_approved', ({ tableId, tableName, message }) => {
    showTableApprovedModal(tableName, message, tableId);
    loadTables();
  });
  lobbySocket.on('table:request_denied', ({ tableName, message }) => {
    showTableDeniedModal(tableName, message);
  });

  // A new table was opened (broadcast to all players)
  lobbySocket.on('tables:updated', () => {
    loadTables();
  });

  // Rail
  lobbySocket.on('rail:approved', ({ amount, message }) => {
    showToast(`✅ ${message}`, 'success');
    setTimeout(() => window.location.href = '/lobby.html', 1500);
  });
  lobbySocket.on('rail:denied', ({ message }) => {
    showToast(message, 'error');
  });

  // Admin broadcast messages
  lobbySocket.on('broadcast_message', (msg) => {
    console.log('[lobby] broadcast_message received:', msg);
    if (!inboxMessages.find(m => m.id === msg.id)) {
      inboxMessages.unshift(msg);
    }
    updateInboxBadge();
    showAdminMessage(msg.from, msg.message, msg.pending, msg.id);
  });
  // Legacy event name fallback
  lobbySocket.on('broadcast:message', (msg) => {
    console.log('[lobby] broadcast:message (legacy) received:', msg);
    if (!inboxMessages.find(m => m.id === msg.id)) inboxMessages.unshift(msg);
    updateInboxBadge();
    showAdminMessage(msg.from, msg.message, msg.pending, msg.id);
  });

  // Ban enforcement
  lobbySocket.on('banned', ({ message }) => {
    clearAuth();
    showBannedModal(message);
  });

  // Live jackpot updates
  lobbySocket.on('jackpot_state', (state) => {
    handleJackpotState(state);
  });

  lobbySocket.on('jackpot_awarded', ({ amount, tableId }) => {
    showToast(`🏆 High Hand Jackpot of $${fmtChips(amount)} awarded!`, 'success');
    loadJackpot();
  });
}

// ─── Tables ───────────────────────────────────────────────────────────────

async function loadTables() {
  try {
    const tables = await apiFetch('/api/tables');
    renderTables(tables);
  } catch (e) {
    document.getElementById('tables-grid').innerHTML = `<div class="empty-state">Failed to load tables</div>`;
  }
}

function renderTables(tables) {
  const el = document.getElementById('tables-grid');
  if (!tables.length) {
    el.innerHTML = '<div class="empty-state">No tables open yet. Ask admin to create one.</div>';
    return;
  }

  el.innerHTML = tables.map(t => {
    const seated = t.table_seats?.[0]?.count || 0;
    const dots = Array.from({ length: t.max_players }, (_, i) =>
      `<span class="player-dot ${i < seated ? '' : 'empty'}"></span>`
    ).join('');
    // Find this table's jackpot data
    const jp = (jackpotData?.tables || []).find(j => j.tableId === t.id);
    const jpLine = jp
      ? `<div style="font-size:.78rem;color:var(--gold);margin-top:4px">🏆 Jackpot: $${fmtChips(jp.amount)}${jp.highHandUsername ? ` — ${esc(jp.highHandUsername)}` : ''}</div>`
      : '';

    const minBuyIn = getMinBuyIn(t.stakes_small_blind, t.stakes_big_blind, t.game_type);
    return `
    <div class="table-card" onclick="openJoinModal('${t.id}', ${t.stakes_small_blind}, ${t.stakes_big_blind}, '${t.game_type}')">
      <div class="table-card-header">
        <div class="table-name">${esc(t.name)}</div>
        <span class="game-badge">${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</span>
      </div>
      <div class="table-stakes">$${t.stakes_small_blind}/$${t.stakes_big_blind}</div>
      <div class="table-info">Max Players: ${t.max_players} | Rake: ${t.rake_percent}% | Min: $${fmtChips(minBuyIn)}</div>
      ${jpLine}
      <div class="player-count">${dots} <span style="margin-left:4px">${seated}/${t.max_players} seated</span></div>
      <button class="btn btn-gold btn-sm btn-full">Join Table →</button>
    </div>`;
  }).join('');
}

// ─── Tournaments ──────────────────────────────────────────────────────────

async function loadTournaments() {
  try {
    const tournaments = await apiFetch('/api/tournaments');
    renderTournaments(tournaments);
  } catch {}
}

function renderTournaments(list) {
  const el = document.getElementById('tournaments-grid');
  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No tournaments scheduled</div>';
    return;
  }

  el.innerHTML = list.map(t => {
    const players = t.tournament_players?.[0]?.count || 0;
    const statusColor = { registering: '#2ecc71', active: '#e63946', completed: '#888' }[t.status] || '#888';
    return `
    <div class="table-card">
      <div class="table-card-header">
        <div class="table-name">${esc(t.name)}</div>
        <span class="game-badge" style="background:${statusColor}22;color:${statusColor}">${t.status}</span>
      </div>
      <div class="table-stakes">Buy-in: ${fmtChips(t.buy_in)} chips</div>
      <div class="table-info">Starting: ${fmtChips(t.starting_chips)} chips</div>
      <div class="player-count"><span class="player-dot"></span> ${players} registered</div>
      ${t.status === 'registering' ? `<button class="btn btn-gold btn-sm btn-full" onclick="registerTournament('${t.id}')">Register →</button>` : ''}
      ${t.status === 'active' ? `<button class="btn btn-blue btn-sm btn-full">Spectate</button>` : ''}
    </div>`;
  }).join('');
}

async function registerTournament(id) {
  try {
    await apiFetch(`/api/tournaments/${id}/register`, { method: 'POST' });
    showToast('Registered for tournament!');
    loadTournaments();
    refreshChips();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ─── Jackpot ──────────────────────────────────────────────────────────────

const JACKPOT_INTERVAL_MS = 30 * 60 * 1000;
let jackpotTimerTick = null;

async function loadJackpot() {
  try {
    jackpotData = await apiFetch('/api/jackpot');
    updateJackpotDisplay(jackpotData.tables || []);
  } catch {}
  setTimeout(loadJackpot, 60000);
}

function updateJackpotDisplay(tables) {
  // Total across all tables in banner
  const total = (tables || []).reduce((s, t) => s + (t.amount || 0), 0);
  document.getElementById('jackpot-amount').textContent = `$${fmtChips(total)}`;

  // Timer: use the earliest-expiring table, or show — if none
  if (tables && tables.length > 0) {
    const earliest = tables.reduce((min, t) => t.timerRemainingMs < min.timerRemainingMs ? t : min, tables[0]);
    if (jackpotTimerTick) clearInterval(jackpotTimerTick);
    jackpotTimerTick = setInterval(() => {
      const now = Date.now();
      let minRemaining = Infinity;
      (jackpotData?.tables || []).forEach(t => {
        const remaining = Math.max(0, JACKPOT_INTERVAL_MS - (now - t.timerStart));
        if (remaining < minRemaining) minRemaining = remaining;
      });
      if (minRemaining === Infinity) { document.getElementById('jackpot-timer').textContent = '–'; return; }
      const min = Math.floor(minRemaining / 60000);
      const sec = Math.floor((minRemaining % 60000) / 1000);
      document.getElementById('jackpot-timer').textContent = `Resets in ${min}:${sec.toString().padStart(2, '0')}`;
    }, 1000);
  } else {
    document.getElementById('jackpot-timer').textContent = '–';
  }
}

// Called when socket pushes jackpot_state
function handleJackpotState(state) {
  jackpotData = state;
  const tables = state.tables || [];
  const total = state.total || state.amount || 0;
  document.getElementById('jackpot-amount').textContent = `$${fmtChips(total)}`;
  if (tables.length > 0) {
    const min30 = tables.reduce((a, t) => t.timerRemainingMs < a ? t.timerRemainingMs : a, Infinity);
    const min = Math.floor(min30 / 60000);
    const sec = Math.floor((min30 % 60000) / 1000);
    document.getElementById('jackpot-timer').textContent = `Resets in ${min}:${sec.toString().padStart(2, '0')}`;
  }
}

// ─── Buy-In Rules ──────────────────────────────────────────────────────────

function getMinBuyIn(sb, bb, gameType) {
  sb = Number(sb); bb = Number(bb);
  if (gameType === 'plo') {
    if (sb === 2 && bb === 2) return 100;
    return bb * 50;          // generic PLO fallback
  }
  // No Limit Hold'em exact house rules
  if (sb === 1 && bb === 3)  return 60;
  if (sb === 2 && bb === 5)  return 200;
  if (sb === 5 && bb === 5)  return 500;
  if (sb === 5 && bb === 10) return 500;
  return bb * 20;             // generic NL fallback
}

// ─── Join / Create ─────────────────────────────────────────────────────────

function openJoinModal(tableId, sb, bb, gameType) {
  const u = getUser();
  const chips = u.chips || (u.isAdmin ? 100000 : 0);
  const minBuyIn = getMinBuyIn(sb, bb, gameType);

  if (!u.isAdmin && chips < minBuyIn) {
    _openBuyInFromTable(minBuyIn, chips);
    return;
  }
  if (!u.isAdmin && chips <= 0) {
    _openBuyInFromTable(minBuyIn, 0);
    return;
  }

  document.getElementById('join-table-id').value = tableId;
  document.getElementById('join-table-bb').value = bb;
  document.getElementById('join-table-min').value = minBuyIn;

  const input = document.getElementById('join-buyin');
  input.value = minBuyIn;
  input.min = minBuyIn;
  input.max = chips;

  const gameLabel = gameType === 'plo' ? 'PLO' : "Hold'em";
  document.getElementById('join-modal-stakes').textContent = `$${sb}/$${bb} ${gameLabel}`;
  document.getElementById('join-balance-info').innerHTML =
    `<strong style="color:var(--chip-green)">Min buy-in: $${fmtChips(minBuyIn)}</strong> &nbsp;·&nbsp; Your balance: $${fmtChips(chips)} &nbsp;·&nbsp; Max: $${fmtChips(chips)}`;

  openModal('join-table-modal');
}

function joinTable() {
  const tableId = document.getElementById('join-table-id').value;
  const buyIn = parseInt(document.getElementById('join-buyin').value);
  const minBuyIn = parseInt(document.getElementById('join-table-min').value) || 0;

  if (minBuyIn && buyIn < minBuyIn) {
    showToast(`Minimum buy-in for this table is $${fmtChips(minBuyIn)}`, 'error');
    document.getElementById('join-buyin').value = minBuyIn;
    return;
  }
  window.location.href = `/table.html?tableId=${tableId}&buyIn=${buyIn}`;
}

function openCreateTable() {
  const u = getUser();
  if (u?.isAdmin) {
    openModal('create-table-modal');
  } else {
    // Host submits a request instead of creating directly
    openModal('request-table-modal');
  }
}

async function createTable() {
  const name = document.getElementById('ct-name').value.trim();
  if (!name) return showToast('Table name required', 'error');
  try {
    await apiFetch('/api/tables', {
      method: 'POST',
      body: {
        name,
        game_type: document.getElementById('ct-type').value,
        stakes_small_blind: parseInt(document.getElementById('ct-sb').value),
        stakes_big_blind: parseInt(document.getElementById('ct-bb').value),
        max_players: parseInt(document.getElementById('ct-max').value),
        rake_percent: parseFloat(document.getElementById('ct-rake').value)
      }
    });
    closeModal('create-table-modal');
    loadTables();
    showToast('Table created!');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function openCreateTournament() { openModal('create-tournament-modal'); }

async function createTournament() {
  const name = document.getElementById('tn-name').value.trim();
  if (!name) return showToast('Name required', 'error');
  try {
    await apiFetch('/api/tournaments', {
      method: 'POST',
      body: {
        name,
        buy_in: parseInt(document.getElementById('tn-buyin').value),
        starting_chips: parseInt(document.getElementById('tn-chips').value)
      }
    });
    closeModal('create-tournament-modal');
    loadTournaments();
    showToast('Tournament created!');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function submitTableRequest() {
  const tableName = document.getElementById('rt-name').value.trim();
  if (!tableName) { document.getElementById('rt-name').focus(); showToast('Please enter a table name', 'error'); return; }
  const sb = parseInt(document.getElementById('rt-sb').value);
  const bb = parseInt(document.getElementById('rt-bb').value);
  const gameType = document.getElementById('rt-type').value;
  const maxPlayers = parseInt(document.getElementById('rt-max').value);
  const rake = parseFloat(document.getElementById('rt-rake').value);
  if (!lobbySocket) return showToast('Not connected', 'error');
  lobbySocket.emit('table:request', { tableName, gameType, sb, bb, maxPlayers, rake });
  closeModal('request-table-modal');
}

function showHostModal(type, message) {
  const existing = document.getElementById('host-modal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'host-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:flex;align-items:center;justify-content:center';
  div.innerHTML = `
    <div style="background:#0a190f;border:2px solid var(--chip-green);border-radius:16px;padding:32px 36px;max-width:420px;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:12px">🎰</div>
      <h2 style="color:var(--chip-green);margin-bottom:10px">Host Status ${type === 'granted' ? 'Granted' : 'Updated'}</h2>
      <p style="color:var(--text);line-height:1.6;margin-bottom:20px">${esc(message)}</p>
      ${type === 'granted' ? '<p style="color:var(--text-dim);font-size:.85rem">You now see a gold HOST badge and a <strong>+ Create Table</strong> button (requires admin approval).</p>' : ''}
      <button class="btn btn-green" onclick="document.getElementById(\'host-modal\').remove()" style="margin-top:16px">Got it!</button>
    </div>`;
  document.body.appendChild(div);
}

function joinRail() {
  const buyin = parseInt(prompt('Requested buy-in amount:', '200') || '0');
  if (buyin <= 0) return;
  if (!lobbySocket) return showToast('Not connected', 'error');
  lobbySocket.emit('rail:join', { buyin });
  showToast('You joined the rail — waiting for admin to seat you');
  // Redirect to waiting room
  setTimeout(() => window.location.href = `/rail.html?buyin=${buyin}`, 1000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function refreshChips() {
  try {
    const profile = await apiFetch('/api/profile');
    const u = getUser();
    u.chips = profile.chips;
    sessionStorage.setItem('rp_user', JSON.stringify(u));
    document.getElementById('header-chips').textContent = u.isAdmin ? '♛ Admin' : fmtChips(profile.chips);
  } catch {}
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ─── Buy-In Request ────────────────────────────────────────────────────────

function openBuyInModal() {
  const ctx = document.getElementById('bi-table-context');
  if (ctx) ctx.style.display = 'none';
  openModal('buyin-request-modal');
}

function _openBuyInFromTable(minBuyIn, currentChips) {
  const ctx = document.getElementById('bi-table-context');
  if (ctx) {
    const need = minBuyIn - Math.max(currentChips, 0);
    ctx.innerHTML = currentChips <= 0
      ? `You have <strong style="color:var(--red)">0 chips</strong>. Request a buy-in below and Roger will add chips right away.`
      : `You need <strong style="color:var(--gold)">$${fmtChips(need)}</strong> more chips to join this table &mdash; min buy-in is <strong>$${fmtChips(minBuyIn)}</strong>, you have <strong>$${fmtChips(currentChips)}</strong>.`;
    ctx.style.display = '';
  }
  document.getElementById('bi-amount').value = minBuyIn;
  openModal('buyin-request-modal');
}

async function submitBuyInRequest() {
  const amount = parseInt(document.getElementById('bi-amount').value);
  const paymentMethod = document.getElementById('bi-method').value;
  const notes = document.getElementById('bi-notes').value.trim();
  if (!amount || amount <= 0) return showToast('Enter a valid amount', 'error');
  try {
    await apiFetch('/api/buyin-request', { method: 'POST', body: { amount, paymentMethod, notes } });
    closeModal('buyin-request-modal');
    showToast('✅ Request sent! Roger will add your chips shortly.');
    document.getElementById('bi-amount').value = '200';
    document.getElementById('bi-notes').value = '';
    const ctx = document.getElementById('bi-table-context');
    if (ctx) ctx.style.display = 'none';
  } catch (e) {
    showToast(e.message || 'Failed to send request', 'error');
  }
}
function fmtChips(n) { return Number(n).toLocaleString(); }
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

let toastContainer = null;
function showToast(msg, type = '') {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function showHostPrivileges() {
  const existing = document.getElementById('host-priv-modal');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.id = 'host-priv-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9000;display:flex;align-items:center;justify-content:center';
  div.innerHTML = `
    <div style="background:#0a190f;border:2px solid var(--chip-green);border-radius:16px;padding:28px 32px;max-width:460px;width:90%">
      <h2 style="color:var(--chip-green);margin:0 0 16px;display:flex;align-items:center;gap:10px"><span>🎰</span> Your Host Privileges</h2>
      <ul style="color:var(--text);line-height:1.9;margin:0 0 20px;padding-left:20px;font-size:.92rem">
        <li><strong style="color:var(--gold)">Create Tables</strong> — Request new cash game tables (admin approves)</li>
        <li><strong style="color:var(--gold)">Add Chips</strong> — Add chips to players at your table mid-session</li>
        <li><strong style="color:var(--gold)">Drop Money Puck</strong> — Activate the money puck / straddle mechanic</li>
        <li><strong style="color:var(--gold)">Join Rail</strong> — Join the waiting queue like any player</li>
      </ul>
      <p style="color:var(--text-dim);font-size:.8rem;margin-bottom:16px">Tap the <strong style="color:var(--chip-green)">+ Create Table</strong> button to submit a table request. Admin will approve or deny it.</p>
      <button class="btn btn-green" onclick="document.getElementById('host-priv-modal').remove()">Got it</button>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

// ─── Inbox ────────────────────────────────────────────────────────────────

async function loadInbox() {
  try {
    const msgs = await apiFetch('/api/messages');
    inboxMessages = msgs || [];
    updateInboxBadge();
  } catch {}
}

function updateInboxBadge() {
  const badge = document.getElementById('inbox-badge');
  if (!badge) return;
  const lastRead = parseInt(localStorage.getItem(INBOX_READ_KEY) || '0');
  const unread = inboxMessages.filter(m => m.sentAt > lastRead).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function openInbox() {
  const existing = document.getElementById('inbox-modal');
  if (existing) { existing.remove(); return; }

  // Mark all as read
  localStorage.setItem(INBOX_READ_KEY, Date.now().toString());
  updateInboxBadge();

  const div = document.createElement('div');
  div.id = 'inbox-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';

  const msgs = inboxMessages.length
    ? inboxMessages.map(m => `
        <div style="border-bottom:1px solid rgba(255,255,255,.08);padding:12px 0">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="color:var(--gold);font-weight:700;font-size:.85rem">📨 ${esc(m.from)}</span>
            <span style="color:var(--text-dim);font-size:.72rem">${new Date(m.sentAt).toLocaleString()}</span>
          </div>
          <div style="color:var(--text);font-size:.9rem;line-height:1.5">${esc(m.message)}</div>
        </div>`).join('')
    : '<div style="color:var(--text-dim);text-align:center;padding:30px">No messages yet</div>';

  div.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:24px;max-width:500px;width:100%;max-height:80vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="color:var(--gold);margin:0">📬 Message Inbox</h2>
        <button onclick="document.getElementById('inbox-modal').remove()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text);border-radius:6px;padding:3px 10px;cursor:pointer">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1">${msgs}</div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

function showAdminMessage(from, message, pending, msgId) {
  const existing = document.getElementById('admin-msg-modal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'admin-msg-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
  div.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:28px 32px;max-width:440px;width:100%;text-align:center;box-shadow:0 0 40px rgba(212,175,55,.25)">
      <div style="font-size:2.2rem;margin-bottom:10px">📨</div>
      <div style="font-size:.72rem;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em">${pending ? 'Missed message' : 'Message from Admin'}</div>
      <div style="font-size:.9rem;color:var(--gold);font-weight:700;margin-bottom:14px">From: ${esc(from)}</div>
      <p style="color:var(--text);line-height:1.7;font-size:.95rem;margin-bottom:16px;white-space:pre-wrap">${esc(message)}</p>
      <div style="margin-bottom:16px;text-align:left" id="admin-msg-reply-area">
        <textarea id="admin-msg-reply-input" placeholder="Reply to admin…" maxlength="500" rows="2"
          style="width:100%;padding:8px 10px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);resize:none;font-family:inherit;font-size:.88rem;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
          <button class="btn btn-sm btn-gold" onclick="sendLobbyReply(${msgId || 'null'})">Send Reply</button>
          <span id="admin-msg-reply-status" style="color:var(--chip-green);font-size:.78rem;align-self:center"></span>
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn btn-gold" onclick="document.getElementById('admin-msg-modal').remove()">Dismiss</button>
        <button class="btn btn-outline" onclick="document.getElementById('admin-msg-modal').remove();openInbox()">View Inbox</button>
      </div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

function sendLobbyReply(replyToId) {
  const input = document.getElementById('admin-msg-reply-input');
  const status = document.getElementById('admin-msg-reply-status');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!lobbySocket) return;
  lobbySocket.emit('player:reply', { replyToId, message: text });
  input.value = '';
  input.disabled = true;
  if (status) { status.textContent = 'Sent!'; setTimeout(() => { status.textContent = ''; if (input) input.disabled = false; }, 3000); }
}

function showTableApprovedModal(tableName, message, tableId) {
  const existing = document.getElementById('table-approved-modal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'table-approved-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9500;display:flex;align-items:center;justify-content:center';
  div.innerHTML = `
    <div style="background:#061a0e;border:2px solid var(--chip-green);border-radius:20px;padding:36px 40px;max-width:460px;width:90%;text-align:center;box-shadow:0 0 60px rgba(0,200,80,.25)">
      <div style="font-size:3rem;margin-bottom:14px">🎉</div>
      <h2 style="color:var(--chip-green);margin:0 0 10px;font-size:1.4rem">Table Request Approved!</h2>
      <p style="color:var(--text);line-height:1.6;font-size:1rem;margin-bottom:8px">${esc(message)}</p>
      <p style="color:var(--text-dim);font-size:.85rem;margin-bottom:24px">Your table is now live in the lobby — players can join immediately.</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        ${tableId ? `<button class="btn btn-gold" onclick="openJoinModal('${tableId}',10);document.getElementById('table-approved-modal').remove()">Go to Table →</button>` : ''}
        <button class="btn btn-outline" onclick="document.getElementById('table-approved-modal').remove()">Back to Lobby</button>
      </div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

function showTableDeniedModal(tableName, message) {
  const existing = document.getElementById('table-denied-modal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'table-denied-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9500;display:flex;align-items:center;justify-content:center';
  div.innerHTML = `
    <div style="background:#1a0606;border:2px solid var(--red);border-radius:20px;padding:36px 40px;max-width:460px;width:90%;text-align:center;box-shadow:0 0 60px rgba(200,0,0,.2)">
      <div style="font-size:3rem;margin-bottom:14px">❌</div>
      <h2 style="color:var(--red);margin:0 0 10px;font-size:1.4rem">Table Request Denied</h2>
      ${tableName ? `<p style="color:var(--gold);font-weight:700;margin-bottom:8px">"${esc(tableName)}"</p>` : ''}
      <p style="color:var(--text);line-height:1.6;font-size:.95rem;margin-bottom:24px">${esc(message)}</p>
      <button class="btn btn-outline" onclick="document.getElementById('table-denied-modal').remove()">Dismiss</button>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

function showBannedModal(message) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;align-items:center;justify-content:center';
  div.innerHTML = `
    <div style="background:#1a0000;border:2px solid var(--red);border-radius:16px;padding:32px 36px;max-width:440px;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:12px">⛔</div>
      <h2 style="color:var(--red);margin-bottom:10px">Account Suspended</h2>
      <p style="color:var(--text);line-height:1.6">${esc(message)}</p>
      <button class="btn btn-outline" onclick="window.location.href='/index.html'" style="margin-top:20px">Go to Login</button>
    </div>`;
  document.body.appendChild(div);
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); });
});
