'use strict';

requireAuth();
const user = getUser();
if (!user.isAdmin) { window.location.href = '/lobby.html'; }

let allPlayers = [];
let allTables = [];
let allTournaments = [];
let currentByTable = []; // session rake by table for overview column

// ─── Init ─────────────────────────────────────────────────────────────────

loadAll();

// ─── Admin Real-time Notifications ────────────────────────────────────────

let adminSocket = null;
if (typeof io !== 'undefined') {
  adminSocket = io({ auth: { token: localStorage.getItem('rp_token') } });
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

  adminSocket.on('admin:notification', (notif) => {
    prependAlertRow(notif);
    bumpAlertBadge();
  });

  adminSocket.on('admin:rail_update', ({ queue }) => {
    renderRail(queue);
  });

  adminSocket.on('admin:table_request', (req) => {
    prependTableRequest(req);
    const cnt = document.getElementById('requests-count');
    if (cnt) cnt.textContent = '';
    loadHosts(); // refresh host panel pending requests
  });

  adminSocket.on('admin:table_request_update', (req) => {
    loadTableRequests();
    loadHosts();
  });

  adminSocket.on('admin:message_sent', ({ id, delivered, queued }) => {
    const status = document.getElementById('msg-status');
    if (status) {
      const total = (delivered || 0) + (queued || 0);
      status.textContent = `Sent! ${delivered} online + ${queued} queued (${total} total)`;
      setTimeout(() => { status.textContent = ''; }, 5000);
    }
  });

  adminSocket.on('admin:message_history', ({ messages }) => {
    renderMessages(messages);
  });
}

async function loadAll() {
  await Promise.all([loadPlayers(), loadPendingPlayers(), loadTables(), loadTournaments(), loadJackpot(), loadRake(), loadSessionRake(), loadNotifications(), loadRail(), loadTableRequests(), loadMessages(), loadHosts()]);
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
  currentByTable = byTable || [];

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

// ─── Alerts / Notifications ───────────────────────────────────────────────

let unreadAlerts = 0;

const NOTIF_ICONS = { allin:'🃏', cashout:'💰', seat_open:'🪑', rail_join:'🎟', new_player:'🆕', player_in_lobby:'👀', table_request:'📋', needs_chips:'🪙' };
const NOTIF_COLORS = { allin:'var(--gold)', cashout:'var(--chip-green)', seat_open:'#7b9fff', rail_join:'#a78bfa', table_request:'var(--gold)', needs_chips:'var(--red)' };

async function loadNotifications() {
  try {
    const list = await apiFetch('/api/admin/notifications');
    const feed = document.getElementById('alerts-feed');
    if (!list.length) { if (feed) feed.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No alerts yet this session</div>'; return; }
    if (feed) feed.innerHTML = list.map(n => alertRowHtml(n)).join('');
  } catch {}
}

function alertRowHtml(n) {
  const icon = NOTIF_ICONS[n.type] || '🔔';
  const color = NOTIF_COLORS[n.type] || 'var(--text)';
  const time = new Date(n.ts).toLocaleTimeString();
  const btns = alertActionBtns(n);
  return `<div class="alert-row" id="alert-${n.id}" style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
    <span style="font-size:1.2rem;flex-shrink:0">${icon}</span>
    <div style="flex:1;min-width:0">
      <div style="color:${color};font-weight:700;font-size:.85rem">${esc(n.title)}</div>
      <div style="color:var(--text);font-size:.82rem;margin:2px 0">${esc(n.body)}</div>
      ${btns}
    </div>
    <span style="color:var(--text-dim);font-size:.72rem;flex-shrink:0">${time}</span>
  </div>`;
}

function alertActionBtns(n) {
  if (n.type === 'allin' && n.data?.userId) {
    return `<button class="btn btn-sm btn-gold" style="margin-top:4px;font-size:.72rem;padding:2px 8px" onclick="quickAddChips('${n.data.userId}','${esc(n.data.username || '')}')">Add Chips (Rebuy)</button>`;
  }
  if (n.type === 'rail_join' && n.data?.userId) {
    return `<div style="display:flex;gap:4px;margin-top:4px">
      <button class="btn btn-sm btn-green" style="font-size:.72rem;padding:2px 8px" onclick="approveRailPlayer('${n.data.userId}',${n.data.buyin||200})">Approve</button>
      <button class="btn btn-sm btn-red" style="font-size:.72rem;padding:2px 8px" onclick="denyRailPlayer('${n.data.userId}')">Deny</button></div>`;
  }
  if (n.type === 'needs_chips' && n.data?.userId) {
    return `<button class="btn btn-sm btn-gold" style="margin-top:4px;font-size:.72rem;padding:2px 8px" onclick="quickAddChips('${n.data.userId}','${esc(n.data.username||'')}')">Add Chips</button>`;
  }
  return '';
}

function prependAlertRow(n) {
  const feed = document.getElementById('alerts-feed');
  if (!feed) return;
  const empty = feed.querySelector('div[style*="text-align:center"]');
  if (empty) feed.innerHTML = '';
  const div = document.createElement('div');
  div.innerHTML = alertRowHtml(n);
  feed.insertBefore(div.firstChild, feed.firstChild);
  if (feed.children.length > 100) feed.lastChild.remove();
}

function bumpAlertBadge() {
  unreadAlerts++;
  const badge = document.getElementById('alert-badge');
  if (badge) { badge.textContent = unreadAlerts; badge.style.display = ''; }
}

function markAllRead() {
  unreadAlerts = 0;
  const badge = document.getElementById('alert-badge');
  if (badge) badge.style.display = 'none';
  toast('All alerts marked read');
}

// ─── Rail Management ──────────────────────────────────────────────────────

async function loadRail() {
  try {
    const queue = await apiFetch('/api/admin/rail');
    renderRail(queue);
  } catch { renderRail([]); }
}

function renderRail(queue) {
  const body = document.getElementById('rail-body');
  const cnt = document.getElementById('rail-count');
  if (!body) return;
  if (cnt) cnt.textContent = queue.length ? `(${queue.length})` : '';
  if (!queue.length) { body.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:8px">No players waiting</div>'; return; }
  body.innerHTML = queue.map((r, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div>
        <span style="color:var(--text-dim);font-size:.75rem;margin-right:8px">#${i+1}</span>
        <strong style="color:var(--text)">${esc(r.username)}</strong>
        ${r.nickname ? `<span style="color:var(--chip-green);margin-left:5px">"${esc(r.nickname)}"</span>` : ''}
        ${r.phone ? `<div style="color:var(--text-dim);font-size:.75rem">📞 ${esc(r.phone)}</div>` : ''}
        <div style="color:var(--text-dim);font-size:.75rem">Buy-in req: $${fmt(r.requestedBuyin)}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm btn-green" onclick="approveRailPlayer('${r.userId}',${r.requestedBuyin||200})">Approve</button>
        <button class="btn btn-sm btn-red" onclick="denyRailPlayer('${r.userId}')">Deny</button>
      </div>
    </div>`).join('');
}

function approveRailPlayer(userId, defaultAmt) {
  const amt = parseInt(prompt(`Approve chips for player:`, defaultAmt || 200) || '0');
  if (!amt || amt <= 0) return;
  adminSocket.emit('rail:approve', { targetUserId: userId, amount: amt });
}

function denyRailPlayer(userId) {
  const reason = prompt('Reason for denial (optional):') || '';
  adminSocket.emit('rail:deny', { targetUserId: userId, reason });
}

// ─── Table Requests ───────────────────────────────────────────────────────

async function loadTableRequests() {
  try {
    const list = await apiFetch('/api/admin/table-requests');
    renderTableRequests(list);
  } catch { renderTableRequests([]); }
}

function renderTableRequests(list) {
  const body = document.getElementById('table-requests-body');
  const cnt = document.getElementById('requests-count');
  if (!body) return;
  const pending = list.filter(r => r.status === 'pending');
  if (cnt) cnt.textContent = pending.length ? `(${pending.length} pending)` : '';
  if (!list.length) { body.innerHTML = '<div style="color:var(--text-dim)">No pending requests</div>'; return; }
  body.innerHTML = list.map(r => {
    const time = new Date(r.requestedAt).toLocaleTimeString();
    const statusColor = r.status === 'approved' ? 'var(--chip-green)' : r.status === 'denied' ? 'var(--red)' : 'var(--gold)';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);flex-wrap:wrap;gap:8px">
      <div>
        <strong style="color:var(--text)">${esc(r.hostName)}</strong>
        <span style="color:var(--text-dim);font-size:.8rem;margin-left:6px">$${r.sb}/$${r.bb} ${r.gameType === 'plo' ? 'PLO' : "Hold'em"} · ${r.maxPlayers}p · ${r.rake}% rake</span>
        <div style="color:var(--text-dim);font-size:.72rem">${time}</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <span style="color:${statusColor};font-size:.75rem;font-weight:700">${r.status.toUpperCase()}</span>
        ${r.status === 'pending' ? `
          <button class="btn btn-sm btn-green" onclick="actionTableRequest(${r.id},'approved')">Approve</button>
          <button class="btn btn-sm btn-red" onclick="actionTableRequest(${r.id},'denied')">Deny</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function prependTableRequest(req) {
  loadTableRequests(); // simple refresh
}

function actionTableRequest(requestId, action) {
  let reason = '';
  if (action === 'denied') reason = prompt('Reason for denial (optional):') || '';
  adminSocket.emit('table:request_action', { requestId, action, reason });
  setTimeout(loadTableRequests, 500);
}

// ─── Hosts ────────────────────────────────────────────────────────────────

let allHosts = [];

async function loadHosts() {
  try {
    allHosts = await apiFetch('/api/admin/hosts');
    renderHosts(allHosts);
    populatePromoteSelector();
    const badge = document.getElementById('hosts-badge');
    if (badge) {
      const pendingCount = allHosts.reduce((sum, h) => sum + (h.tableRequests || []).filter(r => r.status === 'pending').length, 0);
      if (pendingCount) { badge.textContent = pendingCount; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
    const cnt = document.getElementById('hosts-count');
    if (cnt) cnt.textContent = allHosts.length ? `(${allHosts.length})` : '';
  } catch {}
}

function renderHosts(hosts) {
  const list = document.getElementById('hosts-list');
  if (!list) return;

  // Render pending table requests section
  const allPending = hosts.flatMap(h => (h.tableRequests || []).filter(r => r.status === 'pending'));
  const pendingBody = document.getElementById('hosts-pending-body');
  const pendingCnt = document.getElementById('hosts-pending-count');
  if (pendingCnt) pendingCnt.textContent = allPending.length ? `(${allPending.length} pending)` : '';
  if (pendingBody) {
    if (!allPending.length) {
      pendingBody.innerHTML = '<div style="color:var(--text-dim)">No pending table requests</div>';
    } else {
      pendingBody.innerHTML = allPending.map(r => {
        const time = new Date(r.requestedAt).toLocaleTimeString();
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);flex-wrap:wrap;gap:6px">
          <div>
            <strong style="color:var(--text)">${esc(r.hostName)}</strong>
            <span style="color:var(--text-dim);font-size:.8rem;margin-left:6px">$${r.sb}/$${r.bb} ${r.gameType === 'plo' ? 'PLO' : "Hold'em"} · ${r.maxPlayers}p · ${r.rake}% rake</span>
            <div style="color:var(--text-dim);font-size:.72rem">${time}</div>
          </div>
          <div style="display:flex;gap:4px">
            <button class="btn btn-sm btn-green" onclick="actionTableRequest(${r.id},'approved')">Approve</button>
            <button class="btn btn-sm btn-red" onclick="actionTableRequest(${r.id},'denied')">Deny</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Render host cards
  if (!hosts.length) {
    list.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:32px">No hosts assigned yet. Promote a player above.</div>';
    return;
  }

  list.innerHTML = hosts.map(h => {
    const approved = (h.tableRequests || []).filter(r => r.status === 'approved').length;
    const pending  = (h.tableRequests || []).filter(r => r.status === 'pending').length;
    const denied   = (h.tableRequests || []).filter(r => r.status === 'denied').length;
    const rakeColor = h.sessionRakeContrib > 0 ? 'var(--chip-green)' : 'var(--text-dim)';
    return `
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(0,200,0,.2);border-radius:var(--radius);padding:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:1.4rem">🎰</span>
            <strong style="color:var(--chip-green);font-size:1rem">${esc(h.username)}</strong>
            ${h.nickname ? `<span style="color:var(--gold);font-size:.85rem">"${esc(h.nickname)}"</span>` : ''}
            ${h.is_banned ? '<span style="background:var(--red);color:#fff;font-size:.65rem;padding:1px 6px;border-radius:8px">BANNED</span>' : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:4px 16px;font-size:.82rem">
            ${h.full_name ? `<div><span style="color:var(--text-dim)">Name:</span> ${esc(h.full_name)}</div>` : ''}
            ${h.phone ? `<div><span style="color:var(--text-dim)">Phone:</span> ${esc(h.phone)}</div>` : ''}
            ${h.email ? `<div><span style="color:var(--text-dim)">Email:</span> ${esc(h.email)}</div>` : ''}
            <div><span style="color:var(--text-dim)">Chips:</span> <span style="color:var(--gold)">${fmt(h.chips)}</span></div>
            <div><span style="color:var(--text-dim)">Session Rake:</span> <span style="color:${rakeColor}">$${fmt(h.sessionRakeContrib)}</span></div>
            <div><span style="color:var(--text-dim)">Table Reqs:</span>
              <span style="color:var(--chip-green)">${approved}✓</span>
              ${pending ? `<span style="color:var(--gold);margin-left:4px">${pending} pending</span>` : ''}
              ${denied ? `<span style="color:var(--text-dim);margin-left:4px">${denied}✗</span>` : ''}
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:120px">
          <button class="btn btn-sm btn-gold" onclick="openChipsModal('${h.id}','${esc(h.username)}')">Add Chips</button>
          <button class="btn btn-sm btn-red" onclick="revokeHostById('${h.id}','${esc(h.username)}')">Revoke Host</button>
          <button class="btn btn-sm btn-outline" onclick="viewPlayer('${h.id}')">View Profile</button>
        </div>
      </div>
      ${pending > 0 ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)">
        <div style="color:var(--gold);font-size:.78rem;margin-bottom:6px">⏳ Pending requests:</div>
        ${(h.tableRequests || []).filter(r => r.status === 'pending').map(r => `
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:.8rem;padding:4px 0">
            <span style="color:var(--text-dim)">$${r.sb}/$${r.bb} ${r.gameType === 'plo' ? 'PLO' : "Hold'em"} · ${r.maxPlayers}p</span>
            <div style="display:flex;gap:4px">
              <button class="btn btn-sm btn-green" style="padding:2px 8px;font-size:.72rem" onclick="actionTableRequest(${r.id},'approved')">Approve</button>
              <button class="btn btn-sm btn-red" style="padding:2px 8px;font-size:.72rem" onclick="actionTableRequest(${r.id},'denied')">Deny</button>
            </div>
          </div>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
}

function populatePromoteSelector() {
  const sel = document.getElementById('promote-player-select');
  if (!sel) return;
  const hostIds = new Set(allHosts.map(h => h.id));
  // Keep only the default option, then rebuild
  sel.innerHTML = '<option value="">Select a player…</option>';
  for (const p of allPlayers) {
    if (p.is_admin || hostIds.has(p.id) || p.id === user.id) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.username}${p.nickname ? ` "${p.nickname}"` : ''}`;
    sel.appendChild(opt);
  }
}

async function promotePlayerToHost() {
  const id = document.getElementById('promote-player-select').value;
  if (!id) return toast('Select a player first', 'error');
  const p = allPlayers.find(pl => pl.id === id);
  try {
    await apiFetch(`/api/admin/players/${id}/host`, { method: 'POST', body: { isHost: true } });
    toast(`${p?.username || id} promoted to Host`);
    await Promise.all([loadPlayers(), loadHosts()]);
  } catch (e) { toast(e.message, 'error'); }
}

async function revokeHostById(id, username) {
  if (!confirm(`Revoke Host access for ${username}?`)) return;
  try {
    await apiFetch(`/api/admin/players/${id}/host`, { method: 'POST', body: { isHost: false } });
    toast(`Host access revoked for ${username}`);
    await Promise.all([loadPlayers(), loadHosts()]);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Broadcast Messages ───────────────────────────────────────────────────

async function loadMessages() {
  try {
    const list = await apiFetch('/api/admin/messages');
    renderMessages(list);
    populateRecipientSelector();
  } catch {}
}

function populateRecipientSelector() {
  const sel = document.getElementById('msg-recipient');
  if (!sel) return;
  const currentOptions = Array.from(sel.options).map(o => o.value);
  // Add any players not yet in the selector
  for (const p of allPlayers) {
    if (!currentOptions.includes(p.id)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.username}${p.nickname ? ` "${p.nickname}"` : ''}`;
      sel.appendChild(opt);
    }
  }
}

function renderMessages(list) {
  const el = document.getElementById('messages-history');
  if (!el) return;
  if (!list || !list.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No messages sent yet this session</div>';
    return;
  }
  el.innerHTML = list.map(m => {
    const time = new Date(m.sentAt).toLocaleTimeString();
    let targetLabel;
    if (m.targetAll) {
      targetLabel = '<span style="color:var(--gold)">All Players</span>';
    } else {
      const p = allPlayers.find(pl => pl.id === m.targetUserId);
      const name = p ? (p.nickname ? `${p.username} "${p.nickname}"` : p.username) : (m.targetUserId || 'Unknown');
      targetLabel = `<span style="color:var(--chip-green)">${esc(name)}</span>`;
    }
    return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <div style="color:var(--text-dim);font-size:.75rem;margin-bottom:4px">To: ${targetLabel} · From: <strong>${esc(m.from)}</strong> · ${time}</div>
          <div style="color:var(--text);font-size:.88rem">${esc(m.message)}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function sendAdminMessage() {
  if (!adminSocket) return toast('Not connected', 'error');
  const targetUserId = document.getElementById('msg-recipient').value || null;
  const message = document.getElementById('msg-text').value.trim();
  if (!message) return toast('Enter a message', 'error');
  adminSocket.emit('admin:send_message', { targetUserId, message });
  document.getElementById('msg-text').value = '';
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
    populateRecipientSelector();
    populatePromoteSelector();
  } catch (e) { toast(e.message, 'error'); }
}

function renderPlayers(list) {
  const tbody = document.getElementById('players-body');
  tbody.innerHTML = list.map(p => {
    const isSelf = p.id === user.id;
    const roleLabel = p.is_admin ? '<span style="color:var(--gold)">Admin</span>' :
                      p.is_host  ? '<span style="color:var(--chip-green)">Host</span>' :
                                   '<span style="color:var(--text-dim)">Player</span>';
    const selfTag = isSelf ? '<span style="font-size:.65rem;background:rgba(255,200,0,.15);color:var(--gold);padding:1px 5px;border-radius:4px;margin-left:4px">YOU</span>' : '';
    return `
    <tr style="cursor:pointer" onclick="viewPlayer('${p.id}')">
      <td><strong>${esc(p.username)}</strong>${selfTag}${p.full_name ? `<div style="font-size:.75rem;color:var(--text-dim)">${esc(p.full_name)}</div>` : ''}</td>
      <td style="color:var(--chip-green)">${esc(p.nickname || '–')}</td>
      <td style="color:var(--text-dim);font-size:.85rem">${esc(p.phone || '–')}</td>
      <td style="color:var(--gold)">${fmt(p.chips)}</td>
      <td>${roleLabel}</td>
      <td><span style="color:${p.is_banned ? 'var(--red)' : 'var(--chip-green)'}">${p.is_banned ? 'Banned' : 'Active'}</span></td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap">
        <div style="display:flex;align-items:center;gap:4px">
          <input type="number" id="sc-${p.id}" min="0" placeholder="0" style="width:72px;padding:4px 6px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:var(--radius);color:var(--gold);font-size:.8rem" onclick="event.stopPropagation()">
          <button class="btn btn-sm btn-gold" style="padding:4px 8px;font-size:.75rem" onclick="event.stopPropagation();setChipsInline('${p.id}','${esc(p.username)}')">Set</button>
        </div>
      </td>
      <td onclick="event.stopPropagation()"><div class="actions">
        <button class="btn btn-sm btn-outline" onclick="openEditModal('${p.id}')">Edit</button>
        ${!isSelf ? `<button class="btn btn-sm ${p.is_banned ? 'btn-green' : 'btn-red'}" onclick="toggleBan('${p.id}',${!p.is_banned})">${p.is_banned ? 'Unban' : 'Ban'}</button>` : ''}
        ${!isSelf ? `<button class="btn btn-sm btn-red" onclick="deletePlayer('${p.id}','${esc(p.username)}')">Delete</button>` : ''}
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

async function setChipsInline(id, username) {
  const input = document.getElementById(`sc-${id}`);
  const val = input ? input.value.trim() : '';
  if (val === '' || isNaN(Number(val))) return toast('Enter a valid chip amount', 'error');
  const amount = Math.max(0, parseInt(val));
  if (!confirm(`Set ${username}'s chips to ${amount.toLocaleString()}?`)) return;
  try {
    await apiFetch(`/api/admin/players/${id}`, { method: 'PUT', body: { chips_set: amount } });
    if (input) input.value = '';
    toast(`${username} set to ${amount.toLocaleString()} chips`);
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
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

    // Chips button — show for everyone
    const pdChipsBtn = document.getElementById('pd-chips-btn');
    if (pdChipsBtn) {
      pdChipsBtn.style.display = '';
      pdChipsBtn.onclick = () => { closeModal('player-detail-modal'); openChipsModal(id, p.username); };
    }

    // Host toggle (hide for self and admins)
    const pdHostBtn = document.getElementById('pd-host-btn');
    if (pdHostBtn && id !== user.id && !p.is_admin) {
      pdHostBtn.style.display = '';
      pdHostBtn.textContent = p.is_host ? 'Revoke Host' : 'Make Host';
      pdHostBtn.className = `btn ${p.is_host ? 'btn-red' : 'btn-green'}`;
      pdHostBtn.onclick = async () => {
        try {
          await apiFetch(`/api/admin/players/${id}/host`, { method: 'POST', body: { isHost: !p.is_host } });
          toast(p.is_host ? 'Host access revoked' : `Host access granted to ${p.username}`);
          closeModal('player-detail-modal');
          await Promise.all([loadPlayers(), loadHosts()]);
        } catch (e) { toast(e.message, 'error'); }
      };
    } else if (pdHostBtn) {
      pdHostBtn.style.display = 'none';
    }

    // Admin role toggle (hide for self)
    const pdAdminBtn = document.getElementById('pd-admin-btn');
    if (pdAdminBtn && id !== user.id) {
      pdAdminBtn.style.display = '';
      pdAdminBtn.textContent = p.is_admin ? 'Revoke Admin' : 'Make Admin';
      pdAdminBtn.className = `btn ${p.is_admin ? 'btn-red' : 'btn-outline'}`;
      pdAdminBtn.onclick = async () => {
        if (!confirm(`${p.is_admin ? 'Revoke' : 'Grant'} admin access for ${p.username}?`)) return;
        try {
          await apiFetch(`/api/admin/players/${id}/admin`, { method: 'POST', body: { isAdmin: !p.is_admin } });
          toast(`Admin status ${p.is_admin ? 'revoked' : 'granted'} for ${p.username}`);
          closeModal('player-detail-modal');
          loadPlayers();
        } catch (e) { toast(e.message, 'error'); }
      };
    } else if (pdAdminBtn) {
      pdAdminBtn.style.display = 'none';
    }

    openModal('player-detail-modal');
  } catch (e) { toast(e.message, 'error'); }
}

async function openEditModal(id) {
  try {
    const p = await apiFetch(`/api/admin/players/${id}`);
    const isSelf = p.id === user.id;

    // Split full_name into first / last
    const nameParts = (p.full_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    document.getElementById('ep-id').value        = id;
    document.getElementById('ep-firstname').value = firstName;
    document.getElementById('ep-lastname').value  = lastName;
    document.getElementById('ep-nickname').value  = p.nickname  || '';
    document.getElementById('ep-username').value  = p.username  || '';
    document.getElementById('ep-email').value     = p.email     || '';
    document.getElementById('ep-phone').value     = p.phone     || '';
    document.getElementById('ep-address').value   = p.address   || '';
    document.getElementById('ep-city').value      = p.city      || '';
    document.getElementById('ep-state').value     = p.state     || '';
    document.getElementById('ep-zip').value       = p.zip       || '';

    // Role selector
    const role = p.is_admin ? 'admin' : p.is_host ? 'host' : 'player';
    document.getElementById('ep-role').value = role;
    // Prevent self-demotion
    document.getElementById('ep-role').disabled = isSelf;

    // Status selector
    document.getElementById('ep-status').value    = p.is_banned ? 'banned' : 'active';
    document.getElementById('ep-status').disabled = isSelf;

    // Chip display
    document.getElementById('ep-chips-display').textContent = fmt(p.chips || 0) + ' chips';
    document.getElementById('ep-chips-adj').value = '';
    document.getElementById('ep-chips-set').value = '';

    openModal('edit-player-modal');
  } catch (e) { toast(e.message, 'error'); }
}

async function submitEditPlayer() {
  const id = document.getElementById('ep-id').value;
  const firstName = document.getElementById('ep-firstname').value.trim();
  const lastName  = document.getElementById('ep-lastname').value.trim();
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || null;
  const chipsAdj = parseInt(document.getElementById('ep-chips-adj').value) || 0;
  const chipsSetRaw = document.getElementById('ep-chips-set').value.trim();
  const chipsSet = chipsSetRaw !== '' ? Math.max(0, parseInt(chipsSetRaw)) : undefined;

  try {
    await apiFetch(`/api/admin/players/${id}`, {
      method: 'PUT',
      body: {
        full_name: fullName,
        nickname:  document.getElementById('ep-nickname').value.trim()  || null,
        username:  document.getElementById('ep-username').value.trim()  || undefined,
        email:     document.getElementById('ep-email').value.trim()     || null,
        phone:     document.getElementById('ep-phone').value.trim()     || null,
        address:   document.getElementById('ep-address').value.trim()   || null,
        city:      document.getElementById('ep-city').value.trim()      || null,
        state:     document.getElementById('ep-state').value.trim()     || null,
        zip:       document.getElementById('ep-zip').value.trim()       || null,
        role:      document.getElementById('ep-role').disabled ? undefined : document.getElementById('ep-role').value,
        is_banned: document.getElementById('ep-status').disabled ? undefined : document.getElementById('ep-status').value === 'banned',
        chips_set: chipsSet,
        chips_adj: chipsSet !== undefined ? undefined : (chipsAdj || undefined)
      }
    });
    closeModal('edit-player-modal');
    toast('Player saved');
    loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePlayer(id, username) {
  if (id === user.id) return toast('Cannot delete your own account', 'error');
  if (!confirm(`⚠️ Permanently delete "${username}"?\n\nThis will remove all their data and cannot be undone.`)) return;
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
    const rakeEntry = currentByTable.find(r => r.tableId === t.id);
    const rakeDisplay = rakeEntry
      ? `<span style="color:var(--chip-green)">$${fmt(rakeEntry.total)}</span><span style="color:var(--text-dim);font-size:.75rem;margin-left:4px">(${rakeEntry.handCount}h)</span>`
      : '<span style="color:var(--text-dim)">—</span>';
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</td>
      <td>$${t.stakes_small_blind}/$${t.stakes_big_blind}</td>
      <td>${seated}/${t.max_players}</td>
      <td>${rakeDisplay}</td>
      <td><div class="actions">
        <a href="/table.html?tableId=${t.id}&buyIn=${t.stakes_big_blind * 20}"><button class="btn btn-sm btn-outline">View</button></a>
        <button class="btn btn-sm btn-red" onclick="closeTable('${t.id}')">Close</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No active tables</td></tr>';
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
