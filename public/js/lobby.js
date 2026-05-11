'use strict';

requireAuth();

const user = getUser();
let jackpotTimerInterval = null;
let jackpotData = null;

// ─── Init ─────────────────────────────────────────────────────────────────

document.getElementById('header-username').textContent = user.username;
// Hide chip count for admin — show crown instead
document.getElementById('header-chips').textContent = user.isAdmin ? '♛ Admin' : fmtChips(user.chips);

function applyRoleUI(isAdmin, isHost) {
  if (isAdmin) {
    document.getElementById('admin-link').style.display = '';
    document.getElementById('create-table-btn').style.display = '';
    document.getElementById('create-tournament-btn').style.display = '';
  } else if (isHost) {
    document.getElementById('create-table-btn').style.display = '';
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
  if (u) { u.isAdmin = isAdmin; u.chips = profile.chips; localStorage.setItem('rp_user', JSON.stringify(u)); }
  // Admins see a crown instead of chip count
  document.getElementById('header-chips').textContent = isAdmin ? '♛ Admin' : fmtChips(profile.chips);
}).catch(() => {});

loadTables();
loadTournaments();
loadJackpot();

// ─── Admin Socket (notifications) ─────────────────────────────────────────

if (user.isAdmin && typeof io !== 'undefined') {
  const adminSocket = io({ auth: { token: localStorage.getItem('rp_token') } });
  adminSocket.on('connect', () => adminSocket.emit('lobby:join'));

  adminSocket.on('admin:new_player', ({ userId, username }) => {
    showAdminNotification(`New registration: ${username}`, userId, username, 'registered');
  });

  adminSocket.on('admin:player_in_lobby', ({ userId, username }) => {
    showAdminNotification(`${username} is in the lobby`, userId, username, 'lobby');
  });
}

function showAdminNotification(bodyText, userId, username, type) {
  const popup = document.getElementById('admin-notify-popup');
  if (!popup) return;

  document.getElementById('notify-title').textContent = type === 'registered' ? '🔔 New Registration' : '🎯 Player in Lobby';
  document.getElementById('notify-body').textContent = bodyText;

  // "Add Chips & Seat" button
  const seatBtn = document.getElementById('notify-seat-btn');
  seatBtn.onclick = async () => {
    const amt = parseInt(prompt(`Add chips for ${username}:`, '1000'));
    if (!amt || amt <= 0) return;
    try {
      await apiFetch(`/api/admin/players/${userId}/seat`, { method: 'POST', body: { amount: amt } });
      showToast(`Added ${fmtChips(amt)} chips to ${username}`);
      popup.style.display = 'none';
    } catch (e) {
      showToast(e.message || 'Failed to add chips', 'error');
    }
  };

  popup.style.display = '';

  // Play a soft notification sound
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch {}

  // Auto-dismiss after 15 seconds
  clearTimeout(popup._dismissTimer);
  popup._dismissTimer = setTimeout(() => { popup.style.display = 'none'; }, 15000);
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

    return `
    <div class="table-card" onclick="openJoinModal('${t.id}', ${t.stakes_big_blind})">
      <div class="table-card-header">
        <div class="table-name">${esc(t.name)}</div>
        <span class="game-badge">${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</span>
      </div>
      <div class="table-stakes">$${t.stakes_small_blind}/$${t.stakes_big_blind}</div>
      <div class="table-info">Max Players: ${t.max_players} | Rake: ${t.rake_percent}%</div>
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

async function loadJackpot() {
  try {
    jackpotData = await apiFetch('/api/jackpot');
    updateJackpotDisplay();
  } catch {}
  setTimeout(loadJackpot, 30000);
}

function updateJackpotDisplay() {
  if (!jackpotData) return;
  document.getElementById('jackpot-amount').textContent = `$${jackpotData.current_amount || 0}`;

  const timerStart = jackpotData.timer_started_at ? new Date(jackpotData.timer_started_at).getTime() : Date.now();
  const intervalMs = 30 * 60 * 1000;
  const remaining = Math.max(0, timerStart + intervalMs - Date.now());
  const min = Math.floor(remaining / 60000);
  const sec = Math.floor((remaining % 60000) / 1000);
  document.getElementById('jackpot-timer').textContent = `Resets in ${min}:${sec.toString().padStart(2, '0')}`;
}

// ─── Join / Create ─────────────────────────────────────────────────────────

function openJoinModal(tableId, bb) {
  const u = getUser();
  if (!u.chips || u.chips <= 0) {
    showToast('You have 0 chips. Contact the admin to receive chips before joining a table.', 'error');
    return;
  }
  document.getElementById('join-table-id').value = tableId;
  document.getElementById('join-table-bb').value = bb;
  document.getElementById('join-buyin').value = bb * 20;
  document.getElementById('join-buyin').min = bb * 10;
  document.getElementById('join-buyin').max = u.chips;
  document.getElementById('join-balance-info').textContent = `Your balance: ${fmtChips(u.chips)} chips. Min buy-in: ${fmtChips(bb * 10)}`;
  openModal('join-table-modal');
}

function joinTable() {
  const tableId = document.getElementById('join-table-id').value;
  const buyIn = parseInt(document.getElementById('join-buyin').value);
  window.location.href = `/table.html?tableId=${tableId}&buyIn=${buyIn}`;
}

function openCreateTable() { openModal('create-table-modal'); }

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

// ─── Helpers ──────────────────────────────────────────────────────────────

async function refreshChips() {
  try {
    const profile = await apiFetch('/api/profile');
    const u = getUser();
    u.chips = profile.chips;
    localStorage.setItem('rp_user', JSON.stringify(u));
    document.getElementById('header-chips').textContent = u.isAdmin ? '♛ Admin' : fmtChips(profile.chips);
  } catch {}
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
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

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); });
});
