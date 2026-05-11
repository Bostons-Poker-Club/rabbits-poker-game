'use strict';

requireAuth();
const user = getUser();
if (!user.isAdmin) { window.location.href = '/lobby.html'; }

let allPlayers = [];
let allTables = [];
let allTournaments = [];

// ─── Init ─────────────────────────────────────────────────────────────────

loadAll();

// ─── Admin Real-time Notifications ────────────────────────────────────────

if (typeof io !== 'undefined') {
  const adminSocket = io({ auth: { token: localStorage.getItem('rp_token') } });
  adminSocket.on('connect', () => adminSocket.emit('lobby:join'));

  adminSocket.on('admin:new_player', ({ username }) => {
    toast(`🔔 New registration: ${username}`, 'success');
    loadPlayers();
    loadPendingPlayers();
  });

  adminSocket.on('admin:player_in_lobby', ({ username }) => {
    toast(`🎯 ${username} is in the lobby`);
    loadPendingPlayers();
  });

  adminSocket.on('admin:rake_update', ({ sessionTotal, hand, byTable }) => {
    updateRakeFeed(sessionTotal, hand, byTable);
  });
}

async function loadAll() {
  await Promise.all([loadPlayers(), loadPendingPlayers(), loadTables(), loadTournaments(), loadJackpot(), loadRake(), loadSessionRake()]);
}

async function loadPendingPlayers() {
  try {
    const list = await apiFetch('/api/admin/pending-players');
    renderPendingPlayers(list);
  } catch { renderPendingPlayers([]); }
}

function renderPendingPlayers(list) {
  const section = document.getElementById('pending-players-section');
  const body = document.getElementById('pending-players-body');
  const count = document.getElementById('pending-count');
  if (!body) return;

  if (!list.length) {
    count.textContent = '';
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  count.textContent = `(${list.length})`;
  body.innerHTML = list.map(p => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div>
        <strong style="color:var(--text)">${esc(p.username)}</strong>
        ${p.nickname ? `<span style="color:var(--chip-green);margin-left:6px">"${esc(p.nickname)}"</span>` : ''}
        ${p.full_name ? `<div style="font-size:.75rem;color:var(--text-dim)">${esc(p.full_name)}</div>` : ''}
        ${p.phone ? `<div style="font-size:.75rem;color:var(--text-dim)">📞 ${esc(p.phone)}</div>` : ''}
      </div>
      <button class="btn btn-sm btn-gold" onclick="quickAddChips('${p.id}','${esc(p.username)}')">Add Chips</button>
    </div>
  `).join('');
}

async function quickAddChips(id, username) {
  const amt = parseInt(prompt(`Add chips for ${username}:`, '1000'));
  if (!amt || amt <= 0) return;
  try {
    await apiFetch(`/api/admin/players/${id}/chips`, { method: 'POST', body: { amount: amt } });
    toast(`Added ${fmt(amt)} chips to ${username}`, 'success');
    loadPendingPlayers();
    loadPlayers();
  } catch (e) { toast(e.message || 'Failed', 'error'); }
}

async function loadSessionRake() {
  try {
    const data = await apiFetch('/api/admin/session-rake');
    updateSessionRakeUI(data.total || 0, data.byTable || [], data.hands || []);
  } catch {}
}

function updateSessionRakeUI(total, byTable, hands) {
  // Stat cards
  document.getElementById('stat-session-rake').textContent = `$${fmt(total)}`;
  document.getElementById('rake-session-total').textContent = `Session total: $${fmt(total)}`;
  const panelEl = document.getElementById('rake-session-total-panel');
  if (panelEl) panelEl.textContent = `$${fmt(total)}`;

  // Grand total line in overview
  const grandEl = document.getElementById('rake-grand-total');
  if (grandEl) grandEl.textContent = `$${fmt(total)}`;

  // Per-table breakdown (overview panel)
  const byTableBody = document.getElementById('rake-by-table-body');
  if (byTableBody) {
    if (!byTable.length) {
      byTableBody.innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-dim)">No hands yet</div>';
    } else {
      byTableBody.innerHTML = byTable.map(t => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <span style="color:var(--text)">${esc(t.tableName)}</span>
          <span style="color:var(--text-dim);font-size:.8rem">${t.handCount} hands</span>
          <strong style="color:var(--chip-green)">$${fmt(t.total)}</strong>
        </div>`).join('');
    }
  }

  // Per-table table in Rake panel
  const panelBody = document.getElementById('rake-by-table-panel-body');
  if (panelBody) {
    if (!byTable.length) {
      panelBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-dim)">No hands this session</td></tr>';
    } else {
      panelBody.innerHTML = byTable.map(t => `
        <tr>
          <td style="color:var(--text)">${esc(t.tableName)}</td>
          <td style="color:var(--text-dim)">${t.handCount}</td>
          <td style="color:var(--chip-green);font-weight:700">$${fmt(t.total)}</td>
        </tr>`).join('') +
        `<tr style="border-top:2px solid rgba(255,255,255,.15)">
          <td colspan="2" style="color:var(--gold);font-weight:700">Grand Total</td>
          <td style="color:var(--gold);font-weight:700">$${fmt(total)}</td>
        </tr>`;
    }
  }

  // Live feed
  if (hands.length) {
    const feed = document.getElementById('rake-live-feed');
    if (feed) {
      feed.innerHTML = hands.slice(0, 50).map(h => {
        const t = new Date(h.ts).toLocaleTimeString();
        const label = h.tableName ? ` [${esc(h.tableName)}]` : '';
        return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">${t}${label} — Pot $${fmt(h.pot)} → Rake <strong style="color:var(--chip-green)">$${fmt(h.rake)}</strong></div>`;
      }).join('');
    }
  }
}

function updateRakeFeed(sessionTotal, hand, byTable) {
  updateSessionRakeUI(sessionTotal, byTable || [], []);
  // Prepend just the new hand to the live feed
  const feed = document.getElementById('rake-live-feed');
  if (!feed || !hand) return;
  const empty = feed.querySelector('div[style*="text-align:center"]');
  if (empty) feed.innerHTML = '';
  const t = new Date().toLocaleTimeString();
  const label = hand.tableName ? ` [${esc(hand.tableName)}]` : '';
  const row = document.createElement('div');
  row.style.cssText = 'padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)';
  row.innerHTML = `${t}${label} — Pot $${fmt(hand.pot)} → Rake <strong style="color:var(--chip-green)">$${fmt(hand.rake)}</strong>`;
  feed.insertBefore(row, feed.firstChild);
  if (feed.children.length > 50) feed.lastChild.remove();
}

// ─── Panel Navigation ─────────────────────────────────────────────────────

function showPanel(name) {
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`panel-${name}`)?.classList.add('active');
  event.currentTarget.classList.add('active');
}

// ─── Players ──────────────────────────────────────────────────────────────

async function loadPlayers() {
  try {
    allPlayers = await apiFetch('/api/admin/players');
    renderPlayers(allPlayers);
    document.getElementById('stat-players').textContent = allPlayers.length;
  } catch (e) { toast(e.message, 'error'); }
}

function renderPlayers(list) {
  const tbody = document.getElementById('players-body');
  tbody.innerHTML = list.map(p => {
    const roleLabel = p.is_admin ? '<span style="color:var(--gold)">Admin</span>' :
                      p.is_host  ? '<span style="color:var(--chip-green)">Host</span>' :
                                   '<span style="color:var(--text-dim)">Player</span>';
    const hostBtnLabel = p.is_host ? 'Revoke Host' : 'Make Host';
    const hostBtnClass = p.is_host ? 'btn-outline' : 'btn-green';
    const chipsBtn = !p.is_admin
      ? `<button class="btn btn-sm btn-gold" onclick="openChipsModal('${p.id}','${esc(p.username)}')">Add Chips</button>`
      : '';
    return `
    <tr style="cursor:pointer" onclick="viewPlayer('${p.id}')">
      <td><strong>${esc(p.username)}</strong>${p.full_name ? `<div style="font-size:.75rem;color:var(--text-dim)">${esc(p.full_name)}</div>` : ''}</td>
      <td style="color:var(--chip-green)">${esc(p.nickname || '–')}</td>
      <td style="color:var(--text-dim);font-size:.85rem">${esc(p.phone || '–')}</td>
      <td style="color:var(--gold)">${p.is_admin ? '∞' : fmt(p.chips)}</td>
      <td>${roleLabel}</td>
      <td><span style="color:${p.is_banned ? 'var(--red)' : 'var(--chip-green)'}">${p.is_banned ? 'Banned' : 'Active'}</span></td>
      <td onclick="event.stopPropagation()"><div class="actions">
        <button class="btn btn-sm btn-outline" onclick="openEditModal('${p.id}')">Edit</button>
        ${chipsBtn}
        ${!p.is_admin ? `<button class="btn btn-sm ${hostBtnClass}" onclick="toggleHost('${p.id}',${!p.is_host})">${hostBtnLabel}</button>` : ''}
        <button class="btn btn-sm ${p.is_banned ? 'btn-green' : 'btn-red'}" onclick="toggleBan('${p.id}',${!p.is_banned})">${p.is_banned ? 'Unban' : 'Ban'}</button>
        ${!p.is_admin ? `<button class="btn btn-sm btn-red" onclick="deletePlayer('${p.id}','${esc(p.username)}')">Delete</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
}

function filterPlayers() {
  const q = document.getElementById('player-search').value.toLowerCase();
  renderPlayers(allPlayers.filter(p =>
    p.username.toLowerCase().includes(q) ||
    (p.nickname || '').toLowerCase().includes(q) ||
    (p.email || '').toLowerCase().includes(q) ||
    (p.phone || '').includes(q)
  ));
}

function openChipsModal(id, name) {
  document.getElementById('chips-player-id').value = id;
  document.getElementById('chips-player-name').textContent = `Player: ${name}`;
  document.getElementById('chips-amount').value = '1000';
  openModal('chips-modal');
}

async function submitChips() {
  const id = document.getElementById('chips-player-id').value;
  const amount = parseInt(document.getElementById('chips-amount').value);
  if (!amount || isNaN(amount)) return toast('Enter a valid amount', 'error');
  try {
    await apiFetch(`/api/admin/players/${id}/chips`, { method: 'POST', body: { amount } });
    closeModal('chips-modal');
    toast(`${amount > 0 ? '+' : ''}${amount.toLocaleString()} chips applied`);
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleHost(id, isHost) {
  try {
    await apiFetch(`/api/admin/players/${id}/host`, { method: 'POST', body: { isHost } });
    toast(isHost ? 'Host access granted' : 'Host access revoked');
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function viewPlayer(id) {
  try {
    const p = await apiFetch(`/api/admin/players/${id}`);
    const role = p.is_admin ? 'Admin' : p.is_host ? 'Host' : 'Player';
    const joined = p.created_at ? new Date(p.created_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : '–';
    const address = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '–';

    document.getElementById('pd-username').textContent = p.username;
    document.getElementById('pd-avatar').textContent = p.is_admin ? '👑' : p.is_host ? '🎰' : '🐇';
    document.getElementById('pd-grid').innerHTML = `
      <div class="pd-row"><span class="pd-label">Full Name</span><span class="pd-value">${esc(p.full_name || '–')}</span></div>
      <div class="pd-row"><span class="pd-label">Nickname</span><span class="pd-value" style="color:var(--chip-green)">${esc(p.nickname || '–')}</span></div>
      <div class="pd-row"><span class="pd-label">Username</span><span class="pd-value">${esc(p.username)}</span></div>
      <div class="pd-row"><span class="pd-label">Email</span><span class="pd-value">${esc(p.email)}</span></div>
      <div class="pd-row"><span class="pd-label">Phone</span><span class="pd-value">${esc(p.phone || '–')}</span></div>
      <div class="pd-row"><span class="pd-label">Address</span><span class="pd-value">${esc(address)}</span></div>
      <div class="pd-row"><span class="pd-label">Joined</span><span class="pd-value">${joined}</span></div>
      <div class="pd-row"><span class="pd-label">Chips</span><span class="pd-value" style="color:var(--gold)">${p.is_admin ? '∞' : fmt(p.chips)}</span></div>
      <div class="pd-row"><span class="pd-label">Role</span><span class="pd-value">${role}</span></div>
      <div class="pd-row"><span class="pd-label">Status</span><span class="pd-value" style="color:${p.is_banned ? 'var(--red)' : 'var(--chip-green)'}">${p.is_banned ? 'Banned' : 'Active'}</span></div>
    `;
    document.getElementById('pd-edit-btn').onclick = () => { closeModal('player-detail-modal'); openEditModal(id); };
    const pdChipsBtn = document.getElementById('pd-chips-btn');
    if (pdChipsBtn && !p.is_admin) {
      pdChipsBtn.style.display = '';
      pdChipsBtn.onclick = () => { closeModal('player-detail-modal'); openChipsModal(id, p.username); };
    } else if (pdChipsBtn) {
      pdChipsBtn.style.display = 'none';
    }
    openModal('player-detail-modal');
  } catch (e) { toast(e.message, 'error'); }
}

async function openEditModal(id) {
  try {
    const p = await apiFetch(`/api/admin/players/${id}`);
    document.getElementById('ep-id').value = id;
    document.getElementById('ep-fullname').value = p.full_name || '';
    document.getElementById('ep-nickname').value  = p.nickname  || '';
    document.getElementById('ep-email').value     = p.email     || '';
    document.getElementById('ep-phone').value     = p.phone     || '';
    document.getElementById('ep-address').value   = p.address   || '';
    document.getElementById('ep-city').value      = p.city      || '';
    document.getElementById('ep-state').value     = p.state     || '';
    document.getElementById('ep-zip').value       = p.zip       || '';
    openModal('edit-player-modal');
  } catch (e) { toast(e.message, 'error'); }
}

async function submitEditPlayer() {
  const id = document.getElementById('ep-id').value;
  try {
    await apiFetch(`/api/admin/players/${id}`, {
      method: 'PUT',
      body: {
        full_name: document.getElementById('ep-fullname').value.trim() || null,
        nickname:  document.getElementById('ep-nickname').value.trim()  || null,
        email:     document.getElementById('ep-email').value.trim(),
        phone:     document.getElementById('ep-phone').value.trim()     || null,
        address:   document.getElementById('ep-address').value.trim()   || null,
        city:      document.getElementById('ep-city').value.trim()      || null,
        state:     document.getElementById('ep-state').value.trim()     || null,
        zip:       document.getElementById('ep-zip').value.trim()       || null
      }
    });
    closeModal('edit-player-modal');
    toast('Player info saved');
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePlayer(id, username) {
  if (!confirm(`Permanently delete player "${username}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/admin/players/${id}`, { method: 'DELETE' });
    toast(`${username} deleted`);
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleBan(id, banned) {
  try {
    await apiFetch(`/api/admin/players/${id}/ban`, { method: 'POST', body: { banned } });
    toast(banned ? 'Player banned' : 'Player unbanned');
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Tables ───────────────────────────────────────────────────────────────

async function loadTables() {
  try {
    allTables = await apiFetch('/api/tables');
    renderTablesAdmin(allTables);
    renderOverviewTables(allTables);
    document.getElementById('stat-tables').textContent = allTables.filter(t => t.status !== 'closed').length;
  } catch (e) { toast(e.message, 'error'); }
}

function renderTablesAdmin(list) {
  const tbody = document.getElementById('tables-body');
  tbody.innerHTML = list.map(t => `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</td>
      <td>$${t.stakes_small_blind}/$${t.stakes_big_blind}</td>
      <td>${t.max_players}</td>
      <td>${t.rake_percent}%</td>
      <td><span style="color:${t.status === 'closed' ? '#888' : 'var(--chip-green)'}">${t.status}</span></td>
      <td><div class="actions">
        ${t.status !== 'closed' ? `<button class="btn btn-sm btn-red" onclick="closeTable('${t.id}')">Close</button>` : ''}
      </div></td>
    </tr>
  `).join('');
}

function renderOverviewTables(list) {
  const tbody = document.getElementById('active-tables-body');
  const active = list.filter(t => t.status !== 'closed');
  tbody.innerHTML = active.map(t => {
    const seated = t.table_seats?.[0]?.count || 0;
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</td>
      <td>$${t.stakes_small_blind}/$${t.stakes_big_blind}</td>
      <td>${seated}/${t.max_players}</td>
      <td><div class="actions">
        <a href="/table.html?tableId=${t.id}&buyIn=${t.stakes_big_blind * 20}"><button class="btn btn-sm btn-outline">View</button></a>
        <button class="btn btn-sm btn-red" onclick="closeTable('${t.id}')">Close</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No active tables</td></tr>';
}

async function createTable() {
  const name = document.getElementById('ct-name').value.trim();
  if (!name) return toast('Name required', 'error');
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
    toast('Table created');
    loadTables();
  } catch (e) { toast(e.message, 'error'); }
}

async function closeTable(id) {
  if (!confirm('Close this table?')) return;
  try {
    await apiFetch(`/api/tables/${id}`, { method: 'DELETE' });
    toast('Table closed');
    loadTables();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Tournaments ──────────────────────────────────────────────────────────

async function loadTournaments() {
  try {
    allTournaments = await apiFetch('/api/tournaments');
    renderTournamentsAdmin(allTournaments);
  } catch {}
}

function renderTournamentsAdmin(list) {
  const tbody = document.getElementById('tournaments-body');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No tournaments</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(t => {
    const players = t.tournament_players?.[0]?.count || 0;
    const statusColor = { registering: 'var(--chip-green)', active: 'var(--red)', completed: '#888' }[t.status] || '#888';
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td style="color:var(--gold)">${fmt(t.buy_in)}</td>
      <td>${fmt(t.starting_chips)}</td>
      <td><span style="color:${statusColor}">${t.status}</span></td>
      <td>${players}</td>
      <td><div class="actions">
        <button class="btn btn-sm btn-red" onclick="deleteTournament('${t.id}','${esc(t.name)}')">Delete</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function createTournamentAdmin() {
  const name = document.getElementById('tn-name-a').value.trim();
  if (!name) return toast('Name required', 'error');
  try {
    await apiFetch('/api/tournaments', {
      method: 'POST',
      body: {
        name,
        buy_in: parseInt(document.getElementById('tn-buyin-a').value),
        starting_chips: parseInt(document.getElementById('tn-chips-a').value)
      }
    });
    closeModal('create-tournament-modal-admin');
    toast('Tournament created');
    loadTournaments();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteTournament(id, name) {
  if (!confirm(`Delete tournament "${name}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/tournaments/${id}`, { method: 'DELETE' });
    toast('Tournament deleted');
    loadTournaments();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Jackpot ──────────────────────────────────────────────────────────────

let countdownDeadline = null;
let countdownInterval = null;

async function loadJackpot() {
  try {
    const data = await apiFetch('/api/jackpot');
    document.getElementById('jp-amount').textContent = `$${fmt(data.current_amount)}`;
    document.getElementById('stat-jackpot').textContent = `$${fmt(data.current_amount)}`;

    if (data.high_hand_description) {
      document.getElementById('jp-info').textContent = `High hand: ${data.high_hand_description}`;
      document.getElementById('jp-holder').textContent = `Held by: ${data.high_hand_holder}`;
    } else {
      document.getElementById('jp-info').textContent = 'No high hand recorded yet';
      document.getElementById('jp-holder').textContent = '';
    }

    const timerStart = data.high_hand_set_at || data.timer_started_at;
    countdownDeadline = timerStart ? new Date(timerStart).getTime() + 30 * 60 * 1000 : null;
    startCountdown();
  } catch {}
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  tickCountdown();
  countdownInterval = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  const el = document.getElementById('jp-countdown');
  if (!el) return;
  if (!countdownDeadline) { el.textContent = '30:00'; return; }
  const remaining = Math.max(0, countdownDeadline - Date.now());
  const min = Math.floor(remaining / 60000);
  const sec = Math.floor((remaining % 60000) / 1000);
  el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  el.style.color = remaining < 5 * 60 * 1000 ? 'var(--red)' : 'var(--gold)';
}

async function setHighHand() {
  const description = document.getElementById('hh-description').value.trim();
  const holder = document.getElementById('hh-holder').value.trim();
  if (!description) return toast('Enter a hand description', 'error');
  if (!holder) return toast('Enter a player nickname', 'error');
  try {
    await apiFetch('/api/jackpot/high-hand', { method: 'POST', body: { description, holder } });
    toast(`High hand set: ${description} — ${holder}`);
    document.getElementById('hh-description').value = '';
    document.getElementById('hh-holder').value = '';
    loadJackpot();
  } catch (e) { toast(e.message, 'error'); }
}

async function awardJackpot() {
  if (!confirm('Award jackpot to current high hand holder?')) return;
  try {
    const r = await apiFetch('/api/jackpot/award', { method: 'POST' });
    toast(`Jackpot of $${fmt(r.awarded)} awarded!`);
    loadJackpot();
  } catch (e) { toast(e.message, 'error'); }
}

async function resetJackpot() {
  if (!confirm('Reset jackpot timer and high hand?')) return;
  toast('Jackpot reset (via admin socket action)');
}

// ─── Admin Chip Refill ────────────────────────────────────────────────────

async function refillAdminChips() {
  try {
    const r = await apiFetch('/api/admin/refill-chips', { method: 'POST' });
    toast(`Chips refilled to ${fmt(r.chips)}`);
    // Update local display
    const u = getUser();
    if (u) { u.chips = r.chips; localStorage.setItem('rp_user', JSON.stringify(u)); }
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Rake Report ──────────────────────────────────────────────────────────

async function loadRake() {
  try {
    const data = await apiFetch('/api/admin/rake-report');
    document.getElementById('rake-total').textContent = `$${fmt(data.totalRake)}`;
    document.getElementById('rake-jackpot').textContent = `$${fmt(data.totalJackpot)}`;
    document.getElementById('stat-rake').textContent = `$${fmt(data.totalRake)}`;

    const tbody = document.getElementById('rake-body');
    tbody.innerHTML = (data.hands || []).map(h => `
      <tr>
        <td style="font-size:.8rem;color:var(--text-dim)">${h.table_id?.slice(0,8)}…</td>
        <td style="color:var(--chip-green)">$${fmt(h.rake_collected)}</td>
        <td style="color:var(--gold)">$${fmt(h.jackpot_contribution)}</td>
        <td style="color:var(--text-dim);font-size:.8rem">${new Date(h.started_at).toLocaleString()}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No hands yet</td></tr>';
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

const toastContainer = document.getElementById('toast-container');
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); });
});
