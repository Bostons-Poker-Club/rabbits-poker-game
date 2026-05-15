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
  adminSocket = io({ auth: { token: sessionStorage.getItem('rp_token') } });
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
    playNotificationSound();
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
    console.log(`[admin] message_sent — delivered: ${delivered}, queued: ${queued}`);
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

  adminSocket.on('admin:player_reply', (reply) => {
    allPlayerReplies.unshift(reply);
    renderPlayerReplies(allPlayerReplies);
    const badge = document.getElementById('replies-badge');
    if (badge) { badge.textContent = allPlayerReplies.length > 99 ? '99+' : String(allPlayerReplies.length); badge.style.display = ''; }
  });

  // Per-table jackpot events
  adminSocket.on('jackpot_state', (state) => {
    if (state.tables) renderJackpotTables(state.tables);
    const total = state.total || state.amount || 0;
    const jpAmt = document.getElementById('jp-amount');
    const statJp = document.getElementById('stat-jackpot');
    if (jpAmt) jpAmt.textContent = `$${fmt(total)}`;
    if (statJp) statJp.textContent = `$${fmt(total)}`;
  });

  adminSocket.on('jackpot:expired', (data) => {
    handleJackpotExpired(data);
  });

  // Real-time buy-in request notification
  adminSocket.on('admin:buyin_request', (req) => {
    playNotificationSound();
    prependBuyInRow(req);
    const badge = document.getElementById('buyin-badge');
    if (badge) {
      badge.textContent = parseInt(badge.textContent || 0) + 1;
      badge.style.display = '';
    }
    toast(`💰 Buy-In Request: ${req.username} wants $${fmt(req.amount)} chips (${req.paymentMethod})`, 'success');
  });

}

async function loadAll() {
  await Promise.all([loadPlayers(), loadPendingPlayers(), loadTables(), loadTournaments(), loadJackpot(), loadRake(), loadSessionRake(), loadNotifications(), loadRail(), loadTableRequests(), loadMessages(), loadHosts(), loadBuyInRequests(), loadHostApplications(), loadMonthlyFees(), loadRakeSplits(), loadPlayerReplies(), loadSessionReports()]);
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

  // Per-table breakdown (overview panel — compact)
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

  // Per-table table in Rake panel — expanded with host/house cuts
  const panelBody = document.getElementById('rake-by-table-panel-body');
  if (panelBody) {
    if (!byTable.length) {
      panelBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-dim)">No hands this session</td></tr>';
    } else {
      panelBody.innerHTML = byTable.map(t => {
        const hostLabel = t.hostUsername
          ? `${esc(t.hostUsername)} <span style="color:var(--text-dim);font-size:.75rem">(${t.hostType === 'admin' ? 'admin' : 'host'})</span>`
          : '<span style="color:var(--text-dim)">—</span>';
        return `<tr>
          <td style="color:var(--text);font-weight:600">${esc(t.tableName)}</td>
          <td style="color:var(--text-dim);text-align:center">${t.handCount}</td>
          <td style="color:var(--text-dim)">$${fmt(t.potVolume || 0)}</td>
          <td style="color:var(--chip-green);font-weight:700">$${fmt(t.total)}</td>
          <td>${hostLabel}</td>
          <td style="color:var(--text-dim);text-align:center">${t.hostPercent || 0}%</td>
          <td style="color:var(--gold);font-weight:600">$${fmt(t.hostAmount || 0)}</td>
          <td style="color:var(--chip-green);font-weight:600">$${fmt(t.houseAmount || 0)}</td>
        </tr>`;
      }).join('');
    }
  }

  // Grand total box
  const gtBox = document.getElementById('rake-grand-total-box');
  if (gtBox) {
    if (byTable.length) {
      gtBox.style.display = '';
      const totalHostCuts  = byTable.reduce((s, t) => s + (t.hostAmount  || 0), 0);
      const totalHouse     = byTable.reduce((s, t) => s + (t.houseAmount || 0), 0);
      document.getElementById('gt-total-rake').textContent    = `$${fmt(total)}`;
      document.getElementById('gt-host-cuts').textContent     = `$${fmt(totalHostCuts)}`;
      document.getElementById('gt-house-earnings').textContent = `$${fmt(totalHouse)}`;
    } else {
      gtBox.style.display = 'none';
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
            <div><span style="color:var(--text-dim)">All-Time Earned:</span> <span style="color:var(--gold)">$${fmt(h.totalRakeEarned)}</span></div>
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

let allPlayerReplies = [];

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

async function sendAdminMessage() {
  const targetUserId = document.getElementById('msg-recipient').value || null;
  const message = document.getElementById('msg-text').value.trim();
  if (!message) return toast('Enter a message', 'error');
  const status = document.getElementById('msg-status');
  if (status) status.textContent = 'Sending…';
  try {
    const result = await apiFetch('/api/admin/send-message', {
      method: 'POST',
      body: { message, targetUserId }
    });
    console.log('[admin] send-message result:', result);
    document.getElementById('msg-text').value = '';
    if (status) {
      const q = result.queued || 0;
      const d = result.delivered || 0;
      status.textContent = `Sent! ${d} online${q > 0 ? ` + ${q} queued for offline` : ''}`;
      setTimeout(() => { status.textContent = ''; }, 5000);
    }
    loadMessages();
    if (adminSocket) adminSocket.emit('admin:get_messages');
  } catch (e) {
    console.error('[admin] send-message error:', e);
    if (status) status.textContent = 'Error: ' + e.message;
    toast('Failed to send: ' + e.message, 'error');
  }
}

async function loadSessionReports() {
  try {
    const list = await apiFetch('/api/admin/session-reports');
    renderSessionReports(list || []);
  } catch {}
}

function renderSessionReports(list) {
  const el = document.getElementById('session-reports-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-dim)">No session reports yet. Reports are generated automatically when a table is closed.</div>';
    return;
  }
  el.innerHTML = list.map(r => {
    const date = new Date(r.created_at).toLocaleString();
    const hostLabel = r.host_username
      ? `${esc(r.host_username)} <span style="color:var(--text-dim);font-size:.75rem">(${r.host_type === 'admin' ? 'admin' : 'host'})</span>`
      : '<span style="color:var(--text-dim)">No host</span>';
    return `
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div>
            <div style="color:var(--gold);font-weight:700;font-size:1rem">🃏 ${esc(r.table_name)}</div>
            <div style="color:var(--text-dim);font-size:.78rem;margin-top:3px">${date}</div>
          </div>
          <button class="btn btn-sm btn-outline" onclick="viewReportDetail('${r.id}')">View Details</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
          <div style="text-align:center;background:rgba(0,0,0,.3);border-radius:8px;padding:10px">
            <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:4px">Hands</div>
            <div style="color:var(--text);font-weight:700">${r.hands_played}</div>
          </div>
          <div style="text-align:center;background:rgba(0,0,0,.3);border-radius:8px;padding:10px">
            <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:4px">Pot Volume</div>
            <div style="color:var(--text);font-weight:700">$${fmt(r.pot_volume)}</div>
          </div>
          <div style="text-align:center;background:rgba(0,0,0,.3);border-radius:8px;padding:10px">
            <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:4px">Total Rake</div>
            <div style="color:var(--chip-green);font-weight:700">$${fmt(r.total_rake)}</div>
          </div>
          <div style="text-align:center;background:rgba(0,0,0,.3);border-radius:8px;padding:10px">
            <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:4px">Host (${r.host_percent || 0}%)</div>
            <div style="color:var(--gold);font-weight:700">$${fmt(r.host_amount)}</div>
          </div>
          <div style="text-align:center;background:rgba(0,0,0,.3);border-radius:8px;padding:10px">
            <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:4px">House</div>
            <div style="color:var(--chip-green);font-weight:700">$${fmt(r.house_amount)}</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:.82rem;color:var(--text-dim)">Host: ${hostLabel}</div>
      </div>`;
  }).join('');
}

async function viewReportDetail(reportId) {
  let report;
  try {
    report = await apiFetch(`/api/admin/session-reports/${reportId}`);
  } catch (e) { toast('Failed to load report', 'error'); return; }

  const existing = document.getElementById('report-detail-modal');
  if (existing) existing.remove();

  const hands = report.hands_detail || [];
  const handsHtml = hands.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:rgba(255,255,255,.08)">
          <th style="padding:6px 10px;text-align:left">Hand #</th>
          <th style="padding:6px 10px;text-align:right">Pot</th>
          <th style="padding:6px 10px;text-align:right;color:var(--chip-green)">Rake</th>
          <th style="padding:6px 10px;text-align:right;color:var(--text-dim)">Time</th>
        </tr></thead>
        <tbody>${hands.map(h => `
          <tr style="border-bottom:1px solid rgba(255,255,255,.05)">
            <td style="padding:5px 10px;color:var(--text-dim)">#${h.handNum || '–'}</td>
            <td style="padding:5px 10px;text-align:right">$${fmt(h.pot)}</td>
            <td style="padding:5px 10px;text-align:right;color:var(--chip-green);font-weight:600">$${fmt(h.rake)}</td>
            <td style="padding:5px 10px;text-align:right;color:var(--text-dim);font-size:.75rem">${h.ts ? new Date(h.ts).toLocaleTimeString() : ''}</td>
          </tr>`).join('')}</tbody>
      </table>`
    : '<div style="color:var(--text-dim);text-align:center;padding:20px">No hand data available</div>';

  const div = document.createElement('div');
  div.id = 'report-detail-modal';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px';
  div.innerHTML = `
    <div style="background:#0a1a12;border:2px solid var(--gold);border-radius:16px;padding:24px;max-width:640px;width:100%;max-height:88vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h2 style="color:var(--gold);margin:0;font-size:1.1rem">📊 ${esc(report.table_name)}</h2>
          <div style="color:var(--text-dim);font-size:.78rem;margin-top:3px">${new Date(report.created_at).toLocaleString()}</div>
        </div>
        <button onclick="document.getElementById('report-detail-modal').remove()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text);border-radius:6px;padding:3px 10px;cursor:pointer">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
        <div style="text-align:center;background:rgba(0,0,0,.4);border-radius:8px;padding:10px">
          <div style="color:var(--text-dim);font-size:.7rem">Hands</div>
          <div style="color:var(--text);font-weight:700;font-size:1.1rem">${report.hands_played}</div>
        </div>
        <div style="text-align:center;background:rgba(0,0,0,.4);border-radius:8px;padding:10px">
          <div style="color:var(--text-dim);font-size:.7rem">Pot Volume</div>
          <div style="color:var(--text);font-weight:700;font-size:1.1rem">$${fmt(report.pot_volume)}</div>
        </div>
        <div style="text-align:center;background:rgba(0,0,0,.4);border-radius:8px;padding:10px">
          <div style="color:var(--text-dim);font-size:.7rem">Total Rake</div>
          <div style="color:var(--chip-green);font-weight:700;font-size:1.1rem">$${fmt(report.total_rake)}</div>
        </div>
      </div>
      <div style="background:rgba(212,175,55,.08);border:1px solid rgba(212,175,55,.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:.88rem">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Host</span><span style="color:var(--text)">${esc(report.host_username || 'None')} ${report.host_type ? `(${report.host_type})` : ''}</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px"><span style="color:var(--text-dim)">Host Cut (${report.host_percent || 0}%)</span><span style="color:var(--gold);font-weight:700">$${fmt(report.host_amount)}</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px"><span style="color:var(--text-dim)">House Earnings</span><span style="color:var(--chip-green);font-weight:700">$${fmt(report.house_amount)}</span></div>
      </div>
      <div style="overflow-y:auto;flex:1">${handsHtml}</div>
    </div>`;
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  document.body.appendChild(div);
}

async function loadPlayerReplies() {
  try {
    allPlayerReplies = await apiFetch('/api/admin/player-replies');
    renderPlayerReplies(allPlayerReplies);
  } catch {}
}

function renderPlayerReplies(list) {
  const el = document.getElementById('player-replies-list');
  if (!el) return;
  if (!list || !list.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No player replies yet</div>';
    return;
  }
  // Group by player
  const grouped = {};
  for (const r of list) {
    const key = r.fromUsername || r.fromUserId || 'Unknown';
    if (!grouped[key]) grouped[key] = { username: key, replies: [] };
    grouped[key].replies.push(r);
  }
  el.innerHTML = Object.values(grouped).map(g => `
    <div style="margin-bottom:14px;padding:14px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius)">
      <div style="color:var(--chip-green);font-weight:700;margin-bottom:8px;font-size:.88rem">👤 ${esc(g.username)}</div>
      ${g.replies.map(r => `
        <div style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <div style="color:var(--text-dim);font-size:.72rem;margin-bottom:3px">${new Date(r.sentAt).toLocaleString()}${r.replyToId ? ` · re: msg#${r.replyToId}` : ''}</div>
          <div style="color:var(--text);font-size:.88rem">${esc(r.message)}</div>
        </div>`).join('')}
    </div>`).join('');
  const badge = document.getElementById('replies-badge');
  if (badge) { badge.textContent = list.length > 99 ? '99+' : String(list.length); badge.style.display = list.length ? '' : 'none'; }
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

    // Always start on Profile tab and pre-load logs in background
    pdSwitchTab('profile');
    openModal('player-detail-modal');
    _loadPlayerLogs(id);
  } catch (e) { toast(e.message, 'error'); }
}

function pdSwitchTab(tab) {
  const isProfile = tab === 'profile';
  document.getElementById('pd-panel-profile').style.display = isProfile ? '' : 'none';
  document.getElementById('pd-panel-logs').style.display    = isProfile ? 'none' : '';
  document.getElementById('pd-tab-profile').style.borderBottomColor = isProfile ? 'var(--gold)' : 'transparent';
  document.getElementById('pd-tab-profile').style.color = isProfile ? 'var(--gold)' : 'var(--text-dim)';
  document.getElementById('pd-tab-logs').style.borderBottomColor = isProfile ? 'transparent' : 'var(--gold)';
  document.getElementById('pd-tab-logs').style.color = isProfile ? 'var(--text-dim)' : 'var(--gold)';
}

async function _loadPlayerLogs(playerId) {
  const listEl  = document.getElementById('pd-logs-list');
  const statsEl = document.getElementById('pd-logs-stats');
  try {
    const txs = await apiFetch(`/api/admin/players/${playerId}/transactions`);
    if (!txs.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:20px">No transactions yet.</div>';
      statsEl.innerHTML = '';
      return;
    }

    // Compute stats
    let totalBuyin = 0, totalCashout = 0, totalWin = 0, sessions = 0;
    const sessionSet = new Set();
    for (const t of txs) {
      if (t.type === 'buyin' || t.type === 'table_buyin') { totalBuyin += t.amount; sessionSet.add(t.table_name + t.created_at?.slice(0,10)); }
      if (t.type === 'cashout') totalCashout += t.amount;
      if (t.type === 'win')     totalWin += t.amount;
    }
    sessions = sessionSet.size;
    const netChips = totalCashout - totalBuyin;

    statsEl.innerHTML = `
      <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--radius);padding:12px;text-align:center">
        <div style="font-size:.7rem;color:var(--text-dim);margin-bottom:4px">TOTAL BOUGHT IN</div>
        <div style="font-size:1.1rem;font-weight:700;color:var(--gold)">${fmt(totalBuyin)}</div>
      </div>
      <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--radius);padding:12px;text-align:center">
        <div style="font-size:.7rem;color:var(--text-dim);margin-bottom:4px">TOTAL CASHED OUT</div>
        <div style="font-size:1.1rem;font-weight:700;color:var(--chip-green)">${fmt(totalCashout)}</div>
      </div>
      <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--radius);padding:12px;text-align:center">
        <div style="font-size:.7rem;color:var(--text-dim);margin-bottom:4px">NET P&L</div>
        <div style="font-size:1.1rem;font-weight:700;color:${netChips>=0?'var(--chip-green)':'var(--red)'}">${netChips>=0?'+':''}${fmt(netChips)}</div>
      </div>
    `;

    const typeIcon = { buyin:'💰', table_buyin:'🎰', cashout:'💸', win:'🏆' };
    const typeLabel = { buyin:'Buy-In (approved)', table_buyin:'Table Buy-In', cashout:'Cash Out', win:'Hand Win' };

    listEl.innerHTML = txs.map(t => {
      const dt = t.created_at ? new Date(t.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }) : '–';
      const color = t.type === 'win' ? 'var(--chip-green)' : t.type === 'cashout' ? 'var(--chip-green)' : t.type === 'buyin' ? 'var(--gold)' : 'var(--text-dim)';
      const sign  = (t.type === 'win' || t.type === 'cashout') ? '+' : '-';
      const meta  = [t.table_name, t.payment_method, t.notes].filter(Boolean).join(' · ');
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:.82rem">
        <span style="font-size:1.1rem">${typeIcon[t.type]||'📋'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text)">${typeLabel[t.type]||t.type}</div>
          ${meta ? `<div style="color:var(--text-dim);font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(meta)}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:700;color:${color}">${sign}${fmt(t.amount)}</div>
          <div style="font-size:.72rem;color:var(--text-dim)">${dt}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:20px">${e.message === 'Failed to fetch' ? 'Could not load logs.' : esc(e.message)}</div>`;
  }
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
  if (!confirm('End this table session? A rake report will be generated and emailed automatically.')) return;
  try {
    await apiFetch(`/api/tables/${id}`, { method: 'DELETE' });
    toast('Table closed — session report generated');
    loadTables();
    loadSessionReports();
    loadRakeSplits();
    loadSessionRake();
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

// ─── Per-Table Jackpot ────────────────────────────────────────────────────

const JACKPOT_INTERVAL_MS = 30 * 60 * 1000;
let tableCountdownIntervals = {}; // tableId -> intervalId
let currentJackpotTables = [];    // latest state from server
const pendingPayouts = [];         // expired tables waiting for admin confirm

async function loadJackpot() {
  try {
    const data = await apiFetch('/api/jackpot');
    renderJackpotTables(data.tables || []);
    const total = data.total || data.current_amount || 0;
    document.getElementById('jp-amount').textContent = `$${fmt(total)}`;
    document.getElementById('stat-jackpot').textContent = `$${fmt(total)}`;
  } catch {}
}

function renderJackpotTables(tables) {
  currentJackpotTables = tables;

  // Update table selector in set-high-hand form
  const sel = document.getElementById('hh-table-id');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Select a table —</option>' +
      tables.map(t => `<option value="${t.tableId}" ${t.tableId === cur ? 'selected' : ''}>${esc(t.tableName)}</option>`).join('');
  }

  const container = document.getElementById('jp-tables-list');
  if (!container) return;

  // Clear per-table countdown intervals
  Object.values(tableCountdownIntervals).forEach(clearInterval);
  tableCountdownIntervals = {};

  if (!tables.length) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:.9rem;text-align:center;padding:24px">No active tables yet.</div>';
    return;
  }

  container.innerHTML = tables.map(t => {
    const hasWinner = t.highHandUsername || t.highHandDescription;
    const rankLabel = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'][t.highHandRank] || `Rank ${t.highHandRank}`;
    return `
    <div id="jp-table-${t.tableId}" style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:1rem;font-weight:700;color:var(--gold);margin-bottom:6px">🃏 ${esc(t.tableName)}</div>
          <div style="font-size:1.6rem;font-weight:700;color:var(--chip-green)">$${fmt(t.amount)}</div>
          ${hasWinner
            ? `<div style="color:var(--text);margin-top:6px">🏆 <strong>${esc(t.highHandUsername || '—')}</strong> — ${esc(t.highHandDescription || rankLabel)}</div>`
            : `<div style="color:var(--text-dim);margin-top:6px;font-size:.85rem">No high hand recorded yet</div>`}
        </div>
        <div style="text-align:right">
          <div style="font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Resets in</div>
          <div id="jp-cd-${t.tableId}" style="font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--gold)">–:––</div>
          <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
            ${t.amount > 0 && hasWinner ? `<button class="btn btn-gold btn-sm" onclick="awardJackpot('${t.tableId}')">Award $${fmt(t.amount)}</button>` : ''}
            <button class="btn btn-outline btn-sm" onclick="resetJackpot('${t.tableId}')">Reset</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Start per-table countdowns
  tables.forEach(t => {
    const deadline = t.timerStart + JACKPOT_INTERVAL_MS;
    const tick = () => {
      const el = document.getElementById(`jp-cd-${t.tableId}`);
      if (!el) { clearInterval(tableCountdownIntervals[t.tableId]); return; }
      const remaining = Math.max(0, deadline - Date.now());
      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      el.textContent = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      el.style.color = remaining < 5 * 60 * 1000 ? 'var(--red)' : 'var(--gold)';
    };
    tick();
    tableCountdownIntervals[t.tableId] = setInterval(tick, 1000);
  });
}

async function setHighHand() {
  const tableId = document.getElementById('hh-table-id').value;
  const description = document.getElementById('hh-description').value.trim();
  const holder = document.getElementById('hh-holder').value.trim();
  const handRank = parseInt(document.getElementById('hh-rank').value);
  if (!tableId) return toast('Select a table', 'error');
  if (!description) return toast('Enter a hand description', 'error');
  if (!holder) return toast('Enter the player name', 'error');
  try {
    await apiFetch('/api/jackpot/high-hand', { method: 'POST', body: { tableId, description, holder, handRank } });
    toast(`High hand set at selected table: ${description} — ${holder}`);
    document.getElementById('hh-description').value = '';
    document.getElementById('hh-holder').value = '';
    loadJackpot();
  } catch (e) { toast(e.message, 'error'); }
}

async function awardJackpot(tableId) {
  const table = currentJackpotTables.find(t => t.tableId === tableId);
  const label = table ? `${table.tableName} — ${table.highHandUsername} ($${fmt(table.amount)})` : tableId;
  if (!confirm(`Award jackpot for:\n${label}?`)) return;
  try {
    const r = await apiFetch('/api/jackpot/award', { method: 'POST', body: { tableId } });
    toast(`🏆 Jackpot of $${fmt(r.awarded)} awarded to ${table?.highHandUsername || 'winner'}!`);
    loadJackpot();
  } catch (e) { toast(e.message, 'error'); }
}

async function resetJackpot(tableId) {
  if (!confirm('Reset this table\'s jackpot timer and high hand?')) return;
  if (adminSocket) adminSocket.emit('admin:action', { action: 'reset_jackpot', tableId });
  toast('Jackpot reset');
  setTimeout(loadJackpot, 500);
}

// Handle jackpot expiry notification from server
function handleJackpotExpired(data) {
  const { tableName, awarded, winnerName, winnerHand } = data;
  // Show banner notification
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#0a1a12;border:2px solid var(--gold);border-radius:12px;padding:20px 28px;z-index:9999;text-align:center;min-width:320px;box-shadow:0 0 40px rgba(212,175,55,.3)';
  banner.innerHTML = `
    <div style="font-size:1.8rem;margin-bottom:8px">🏆</div>
    <div style="font-weight:700;color:var(--gold);font-size:1.1rem;margin-bottom:4px">Jackpot Expired — ${esc(tableName)}</div>
    <div style="color:var(--text);margin-bottom:4px">${esc(winnerHand)} by <strong>${esc(winnerName)}</strong></div>
    <div style="font-size:1.4rem;font-weight:700;color:var(--chip-green);margin-bottom:14px">$${fmt(awarded)} to award</div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button class="btn btn-gold" onclick="awardJackpot('${data.tableId}');this.closest('div[style]').remove()">Confirm Payout</button>
      <button class="btn btn-outline" onclick="this.closest('div[style]').remove()">Dismiss</button>
    </div>`;
  document.body.appendChild(banner);
  loadJackpot();
}

// ─── Admin Chip Refill ────────────────────────────────────────────────────

async function refillAdminChips() {
  try {
    const r = await apiFetch('/api/admin/refill-chips', { method: 'POST' });
    toast(`Chips refilled to ${fmt(r.chips)}`);
    // Update local display
    const u = getUser();
    if (u) { u.chips = r.chips; sessionStorage.setItem('rp_user', JSON.stringify(u)); }
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

// ─── Sound Notifications ──────────────────────────────────────────────────

const MUTE_KEY = 'rp_admin_muted';
let adminMuted = localStorage.getItem(MUTE_KEY) === 'true';
let mutedCount = 0;

function toggleMute() {
  adminMuted = !adminMuted;
  localStorage.setItem(MUTE_KEY, adminMuted);
  const btn = document.getElementById('mute-btn');
  if (btn) btn.textContent = adminMuted ? '🔇' : '🔊';
  if (!adminMuted) {
    mutedCount = 0;
    const badge = document.getElementById('muted-badge');
    if (badge) badge.style.display = 'none';
  }
  toast(adminMuted ? 'Notifications muted' : 'Notifications unmuted');
}

function playNotificationSound() {
  if (adminMuted) {
    mutedCount++;
    const badge = document.getElementById('muted-badge');
    if (badge) { badge.textContent = mutedCount > 9 ? '9+' : mutedCount; badge.style.display = 'inline-flex'; }
    return;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Poker chip chime: two quick tones
    [[880, 0, 0.12], [1100, 0.12, 0.12]].forEach(([freq, start, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    });
  } catch {}
}

// Apply initial mute state to button
(function() {
  const btn = document.getElementById('mute-btn');
  if (btn && adminMuted) btn.textContent = '🔇';
})();

// ─── Buy-In Requests ──────────────────────────────────────────────────────

async function loadBuyInRequests() {
  try {
    const requests = await apiFetch('/api/admin/buyin-requests');
    renderBuyInRequests(requests);
    const badge = document.getElementById('buyin-badge');
    if (badge) {
      if (requests.length > 0) { badge.textContent = requests.length; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  } catch {}
}

function renderBuyInRequests(requests) {
  const el = document.getElementById('buyin-list');
  if (!el) return;
  if (!requests.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No pending buy-in requests</div>';
    return;
  }
  el.innerHTML = requests.map(r => `
    <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-weight:700;font-size:1rem;color:var(--text)">${esc(r.username)}${r.nickname ? ` <span style="color:var(--text-dim);font-weight:400;font-size:.88rem">(${esc(r.nickname)})</span>` : ''}</div>
        ${r.phone ? `<div style="color:var(--text-dim);font-size:.8rem">📱 ${esc(r.phone)}</div>` : ''}
        <div style="color:var(--chip-green);font-size:1.2rem;font-weight:700">$${fmt(r.amount)} chips</div>
        <div style="color:var(--text-dim);font-size:.82rem;margin-top:2px">💳 ${esc(r.paymentMethod)}${r.notes ? ' — ' + esc(r.notes) : ''}</div>
        <div style="color:var(--text-dim);font-size:.75rem">${new Date(r.requestedAt).toLocaleTimeString()}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-gold btn-sm" onclick="approveBuyIn(${r.id}, '${esc(r.username)}', ${r.amount})">✓ Add $${fmt(r.amount)} Chips</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="denyBuyIn(${r.id})">✗ Deny</button>
      </div>
    </div>`).join('');
}

function prependBuyInRow(r) {
  const el = document.getElementById('buyin-list');
  if (!el) return;
  const empty = el.querySelector('[style*="No pending"]');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.id = `bi-${r.id}`;
  div.style.cssText = 'background:rgba(0,200,80,.08);border:1px solid rgba(0,200,80,.3);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px';
  div.innerHTML = `
    <div>
      <div style="font-weight:700;font-size:1rem;color:var(--chip-green)">🆕 ${esc(r.username)}${r.nickname ? ` <span style="color:var(--text-dim);font-weight:400;font-size:.88rem">(${esc(r.nickname)})</span>` : ''}</div>
      ${r.phone ? `<div style="color:var(--text-dim);font-size:.8rem">📱 ${esc(r.phone)}</div>` : ''}
      <div style="color:var(--chip-green);font-size:1.2rem;font-weight:700">$${fmt(r.amount)} chips</div>
      <div style="color:var(--text-dim);font-size:.82rem;margin-top:2px">💳 ${esc(r.paymentMethod)}${r.notes ? ' — ' + esc(r.notes) : ''}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-gold btn-sm" onclick="approveBuyIn(${r.id}, '${esc(r.username)}', ${r.amount})">✓ Add $${fmt(r.amount)} Chips</button>
      <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="denyBuyIn(${r.id})">✗ Deny</button>
    </div>`;
  el.prepend(div);
}

async function approveBuyIn(id, username, amount) {
  if (!confirm(`Add ${fmt(amount)} chips to ${username}?`)) return;
  try {
    const r = await apiFetch(`/api/admin/buyin-requests/${id}/approve`, { method: 'POST' });
    toast(`✅ ${username} received $${fmt(amount)} chips (new total: $${fmt(r.chips)})`);
    document.getElementById(`bi-${id}`)?.remove();
    loadBuyInRequests();
  } catch (e) { toast(e.message, 'error'); }
}

async function denyBuyIn(id) {
  try {
    await apiFetch(`/api/admin/buyin-requests/${id}/deny`, { method: 'POST' });
    document.getElementById(`bi-${id}`)?.remove();
    toast('Buy-in request denied');
    loadBuyInRequests();
  } catch (e) { toast(e.message, 'error'); }
}

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

// ─── Host Applications ────────────────────────────────────────────────────

async function loadHostApplications() {
  try {
    const list = await apiFetch('/api/admin/host-applications');
    renderHostApplications(list);
    const pending = list.filter(a => a.status === 'pending').length;
    const badge = document.getElementById('app-badge');
    if (badge) {
      badge.textContent = pending;
      badge.style.display = pending ? '' : 'none';
    }
  } catch {}
}

function renderHostApplications(list) {
  const pendingEl   = document.getElementById('applications-pending');
  const reviewedEl  = document.getElementById('applications-reviewed');
  if (!pendingEl) return;

  const pending  = list.filter(a => a.status === 'pending');
  const reviewed = list.filter(a => a.status !== 'pending');

  if (!pending.length) {
    pendingEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No pending applications</div>';
  } else {
    pendingEl.innerHTML = pending.map(a => appCardHtml(a, true)).join('');
  }

  if (reviewedEl) {
    reviewedEl.innerHTML = reviewed.length
      ? reviewed.map(a => appCardHtml(a, false)).join('')
      : '<div style="color:var(--text-dim);font-size:.85rem;padding:8px">No reviewed applications yet.</div>';
  }
}

function appCardHtml(a, isPending) {
  const statusColor = a.status === 'approved' ? 'var(--chip-green)' : a.status === 'rejected' ? 'var(--red)' : 'var(--gold)';
  const submitted   = new Date(a.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  return `<div style="background:rgba(255,255,255,.04);border:1px solid ${isPending ? 'rgba(255,200,0,.3)' : 'var(--border)'};border-radius:var(--radius);padding:16px 18px;margin-bottom:12px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <strong style="color:var(--text);font-size:1rem">${esc(a.full_name)}</strong>
          <span style="font-size:.7rem;font-weight:700;color:${statusColor};text-transform:uppercase">${a.status}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:3px 16px;font-size:.82rem;color:var(--text-dim)">
          <div>📧 ${esc(a.email)}</div>
          <div>📞 ${esc(a.phone)}</div>
          <div>🏠 ${esc(a.address)}</div>
          <div>📅 Submitted ${submitted}</div>
          <div style="color:${a.monthly_fee_agreed ? 'var(--chip-green)' : 'var(--red)'}">
            ${a.monthly_fee_agreed ? '✓' : '✗'} $20/mo fee agreed
          </div>
          <div style="color:${a.rake_agreed ? 'var(--chip-green)' : 'var(--red)'}">
            ${a.rake_agreed ? '✓' : '✗'} 40% rake agreed
          </div>
        </div>
        ${a.government_id_filename ? `<div style="margin-top:6px;font-size:.78rem;color:var(--text-dim)">ID file: ${esc(a.government_id_filename)}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:130px">
        <button class="btn btn-sm btn-outline" onclick="viewGovernmentId('${a.id}')">View ID</button>
        ${isPending ? `
        <button class="btn btn-sm btn-green" onclick="approveHostApp('${a.id}','${esc(a.full_name)}','${esc(a.email)}')">Approve</button>
        <button class="btn btn-sm btn-red"   onclick="rejectHostApp('${a.id}')">Reject</button>` : ''}
      </div>
    </div>
  </div>`;
}

async function approveHostApp(id, name, email) {
  const password = prompt(`Set initial password for ${name} (${email}):\n\nMin 6 characters — they can change it after login.`);
  if (!password) return;
  if (password.length < 6) return toast('Password must be at least 6 characters', 'error');
  try {
    const r = await apiFetch(`/api/admin/host-applications/${id}/approve`, { method: 'POST', body: { password } });
    toast(`✅ ${name} approved — username: ${r.username}`, 'success');
    loadHostApplications();
    loadPlayers();
    loadHosts();
    loadMonthlyFees();
  } catch (e) { toast(e.message, 'error'); }
}

async function rejectHostApp(id) {
  const notes = prompt('Reason for rejection (optional):') ?? null;
  if (notes === null) return; // cancelled
  try {
    await apiFetch(`/api/admin/host-applications/${id}/reject`, { method: 'POST', body: { notes } });
    toast('Application rejected');
    loadHostApplications();
  } catch (e) { toast(e.message, 'error'); }
}

async function viewGovernmentId(appId) {
  const content = document.getElementById('govid-content');
  if (content) content.innerHTML = '<span style="color:var(--text-dim)">Loading…</span>';
  openModal('govid-modal');
  try {
    const r = await apiFetch(`/api/admin/host-applications/${appId}/government-id`);
    if (!r.data) { content.innerHTML = '<span style="color:var(--text-dim)">No ID on file.</span>'; return; }
    if (r.data.startsWith('data:image')) {
      content.innerHTML = `<img src="${r.data}" alt="Government ID" style="max-width:100%;max-height:500px;border-radius:8px">`;
    } else if (r.data.startsWith('data:application/pdf')) {
      content.innerHTML = `<iframe src="${r.data}" style="width:100%;height:500px;border:none;border-radius:8px"></iframe>`;
    } else {
      content.innerHTML = `<a href="${r.data}" download="${esc(r.filename||'government-id')}" class="btn btn-outline">Download ID File</a>`;
    }
  } catch (e) { if (content) content.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
}

// ─── Monthly Fees ─────────────────────────────────────────────────────────

async function loadMonthlyFees() {
  try {
    const list = await apiFetch('/api/admin/monthly-fees');
    renderMonthlyFees(list);
    const overdue = list.filter(f => f.is_overdue).length;
    const badge = document.getElementById('fees-badge');
    if (badge) {
      badge.textContent = overdue;
      badge.style.display = overdue ? '' : 'none';
    }
  } catch {}
}

function renderMonthlyFees(list) {
  const tbody = document.getElementById('fees-body');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim)">No fee records yet. Records are created automatically when hosts or admins are approved.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(f => {
    const lastPaid  = f.last_paid_at ? new Date(f.last_paid_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
    const nextDue   = f.next_due_date ? new Date(f.next_due_date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
    const overdue   = f.is_overdue;
    const statusHtml = overdue
      ? '<span style="background:var(--red);color:#fff;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:8px">OVERDUE</span>'
      : '<span style="color:var(--chip-green);font-size:.82rem">Current</span>';
    const roleLabel = f.role_type === 'admin'
      ? '<span style="color:var(--gold);font-size:.8rem;font-weight:700">Admin</span>'
      : '<span style="color:var(--chip-green);font-size:.8rem">Host</span>';
    return `<tr style="${overdue ? 'background:rgba(255,0,0,.06)' : ''}">
      <td><strong style="color:${overdue ? 'var(--red)' : 'var(--text)'}">${esc(f.username || '—')}</strong></td>
      <td>${roleLabel}</td>
      <td style="color:var(--gold)">$${f.fee_amount}/mo</td>
      <td style="color:var(--text-dim);font-size:.82rem">${lastPaid}</td>
      <td style="color:${overdue ? 'var(--red)' : 'var(--text-dim)'};font-size:.82rem">${nextDue}</td>
      <td>${statusHtml}</td>
      <td><button class="btn btn-sm btn-green" onclick="markFeePaid('${f.user_id}','${esc(f.username||'')}')">Mark Paid</button></td>
    </tr>`;
  }).join('');
}

async function markFeePaid(userId, username) {
  if (!confirm(`Mark monthly fee as paid for ${username}?`)) return;
  try {
    await apiFetch(`/api/admin/monthly-fees/${userId}/mark-paid`, { method: 'POST' });
    toast(`Fee marked as paid for ${username}`);
    loadMonthlyFees();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Rake Splits ──────────────────────────────────────────────────────────

async function loadRakeSplits() {
  try {
    const data = await apiFetch('/api/admin/rake-splits');
    renderRakeSplits(data.splits || [], data.byHost || []);
  } catch {}
}

function renderRakeSplits(splits, byHost) {
  // Earnings by host summary
  const summaryEl = document.getElementById('rake-splits-by-host');
  if (summaryEl) {
    if (!byHost.length) {
      summaryEl.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:16px;font-size:.88rem">No rake splits yet — splits are recorded when a table session is closed.</div>';
    } else {
      summaryEl.innerHTML = byHost.map(h => {
        const roleLabel = h.host_type === 'admin' ? '<span style="color:var(--gold);font-size:.72rem">Admin (20%)</span>' : '<span style="color:var(--chip-green);font-size:.72rem">Host (40%)</span>';
        return `<div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px">
          <div>
            <strong style="color:var(--text)">${esc(h.host_username || '—')}</strong>
            &nbsp;${roleLabel}
          </div>
          <div style="text-align:right">
            <div style="color:var(--gold);font-weight:700;font-size:1.1rem">$${fmt(h.total_earned)}</div>
            <div style="color:var(--text-dim);font-size:.75rem">${h.sessions} session${h.sessions !== 1 ? 's' : ''}</div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Split history table
  const tbody = document.getElementById('rake-splits-body');
  if (!tbody) return;
  if (!splits.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim)">No rake splits recorded yet</td></tr>';
    return;
  }
  tbody.innerHTML = splits.map(s => {
    const date  = new Date(s.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const hType = s.host_type === 'admin' ? '<span style="color:var(--gold);font-size:.75rem">Admin</span>' : s.host_type ? '<span style="color:var(--chip-green);font-size:.75rem">Host</span>' : '—';
    return `<tr>
      <td>${esc(s.table_name || '—')}</td>
      <td style="font-size:.8rem;color:var(--text-dim)">${date}</td>
      <td style="color:var(--text)">$${fmt(s.total_rake)}</td>
      <td>${esc(s.host_username || '—')} ${hType}</td>
      <td style="color:var(--text-dim)">${s.host_percent}%</td>
      <td style="color:var(--chip-green);font-weight:600">$${fmt(s.host_amount)}</td>
      <td style="color:var(--gold);font-weight:600">$${fmt(s.house_amount)}</td>
    </tr>`;
  }).join('');
}

// ─── Create Admin Account ─────────────────────────────────────────────────

let caGovIdData     = null;
let caGovIdFilename = null;

function caHandleFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('File too large (max 8MB)', 'error'); return; }
  caGovIdFilename = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    caGovIdData = e.target.result;
    document.getElementById('ca-upload-placeholder').style.display = 'none';
    const done = document.getElementById('ca-upload-done');
    done.style.display  = '';
    done.textContent    = '✓ ' + file.name;
    document.getElementById('ca-upload-zone').style.borderColor = 'var(--chip-green)';
  };
  reader.readAsDataURL(file);
}

async function submitCreateAdmin() {
  const fullName  = document.getElementById('ca-fullname').value.trim();
  const phone     = document.getElementById('ca-phone').value.trim();
  const email     = document.getElementById('ca-email').value.trim();
  const address   = document.getElementById('ca-address').value.trim();
  const username  = document.getElementById('ca-username').value.trim();
  const password  = document.getElementById('ca-password').value;
  const feeAgree  = document.getElementById('ca-fee-agree').checked;
  const rakeAgree = document.getElementById('ca-rake-agree').checked;
  const errEl     = document.getElementById('ca-error');
  errEl.textContent = '';

  if (!fullName)    return (errEl.textContent = 'Full legal name is required');
  if (!phone)       return (errEl.textContent = 'Phone is required');
  if (!email)       return (errEl.textContent = 'Email is required');
  if (!address)     return (errEl.textContent = 'Address is required');
  if (!username)    return (errEl.textContent = 'Username is required');
  if (!password || password.length < 6) return (errEl.textContent = 'Password required (min 6 chars)');
  if (!caGovIdData) return (errEl.textContent = 'Government ID photo is required');
  if (!feeAgree)    return (errEl.textContent = 'Must agree to the $40/month admin fee');
  if (!rakeAgree)   return (errEl.textContent = 'Must agree to 20% rake contribution');

  try {
    const r = await apiFetch('/api/admin/create-admin', {
      method: 'POST',
      body: {
        full_name: fullName,
        phone, email, address, username, password,
        government_id_data: caGovIdData,
        government_id_filename: caGovIdFilename,
        monthly_fee_agreed: feeAgree,
        rake_agreed: rakeAgree
      }
    });
    closeModal('create-admin-modal');
    toast(`✅ Admin account created — username: ${r.username}`, 'success');
    // Reset form
    ['ca-fullname','ca-phone','ca-email','ca-address','ca-username','ca-password'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('ca-fee-agree').checked  = false;
    document.getElementById('ca-rake-agree').checked = false;
    caGovIdData = null; caGovIdFilename = null;
    document.getElementById('ca-upload-placeholder').style.display = '';
    document.getElementById('ca-upload-done').style.display = 'none';
    document.getElementById('ca-upload-zone').style.borderColor = '';
    loadPlayers();
    loadMonthlyFees();
  } catch (e) { errEl.textContent = e.message; }
}
