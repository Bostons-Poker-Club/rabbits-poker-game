'use strict';

requireAuth();
const user = getUser();
if (!user.isAdmin) { window.location.href = '/lobby.html'; }

let allPlayers = [];
let allTables = [];
let allTournaments = [];
let _currentPdPlayerId = null;
let currentByTable = []; // session rake by table for overview column

// ─── Init ─────────────────────────────────────────────────────────────────

loadAll();

// ─── Admin Real-time Notifications ────────────────────────────────────────

let adminSocket = null;
if (typeof io !== 'undefined') {
  adminSocket = io({
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    auth: { token: sessionStorage.getItem('rp_token') }
  });
  adminSocket.on('connect', () => { adminSocket.emit('lobby:join'); adminSocket.emit('admin:get_overview'); _loadMaintenanceState(); });

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

  adminSocket.on('admin:overview', (tables) => {
    renderLiveTableOverview(tables);
  });

  // Tournament real-time events
  adminSocket.on('tournament_standings', ({ tournamentId, standings, prize, activePlayers }) => {
    _renderAdminStandings(standings, prize, activePlayers);
  });

  adminSocket.on('tournament_break_start', ({ tournamentId, breakRemainingMs }) => {
    toast(`☕ Tournament break started`, 'warn');
    document.getElementById('adm-break-extend-btn')?.style && (document.getElementById('adm-break-extend-btn').style.display = '');
    document.getElementById('adm-break-end-btn')?.style && (document.getElementById('adm-break-end-btn').style.display = '');
  });

  adminSocket.on('tournament_break_end', () => {
    document.getElementById('adm-break-extend-btn')?.style && (document.getElementById('adm-break-extend-btn').style.display = 'none');
    document.getElementById('adm-break-end-btn')?.style && (document.getElementById('adm-break-end-btn').style.display = 'none');
    toast('▶ Tournament break ended');
  });

  adminSocket.on('blind_increase', ({ tournamentId, blindLevel, small_blind, big_blind }) => {
    toast(`📈 Level ${blindLevel}: $${small_blind}/$${big_blind}`);
  });

  adminSocket.on('player_eliminated', ({ username, placement }) => {
    toast(`❌ ${username} eliminated — ${placement}${_admOrdinal(placement)} place`);
  });

  adminSocket.on('tournament_ended', ({ winner, standings, prize }) => {
    toast(`🏆 Tournament ended! ${winner?.username || 'Winner'} wins $${prize?.toLocaleString() || '?'}!`);
    _renderAdminStandings(standings, prize, 0);
    loadTournaments();
  });

}

async function loadAll() {
  await Promise.all([loadPlayers(), loadPendingPlayers(), loadTables(), loadTournaments(), loadJackpot(), loadRake(), loadSessionRake(), loadNotifications(), loadRail(), loadTableRequests(), loadMessages(), loadHosts(), loadBuyInRequests(), loadHostApplications(), loadMonthlyFees(), loadRakeSplits(), loadPlayerReplies(), loadSessionReports(), loadFailedLogins()]);
  _loadNoteCounts();
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
          <button class="btn btn-sm btn-outline" onclick="openHostBudgetModal('${h.id}','${esc(h.username)}',${h.host_chip_budget||0},${h.host_chips_used||0})">💰 Budget</button>
          <button class="btn btn-sm btn-outline" onclick="viewHostTransactions('${h.id}','${esc(h.username)}')">📋 Chip Log</button>
          <button class="btn btn-sm btn-red" onclick="revokeHostById('${h.id}','${esc(h.username)}')">Revoke Host</button>
          <button class="btn btn-sm btn-outline" onclick="viewPlayer('${h.id}')">View Profile</button>
        </div>
      </div>
      <div style="margin-top:8px;padding:6px 8px;background:rgba(255,255,255,.03);border-radius:6px;font-size:.78rem;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <span style="color:var(--text-dim)">Chip Budget:</span>
        ${(h.host_chip_budget||0) > 0
          ? `<span style="color:var(--chip-green);font-weight:700">$${fmt(h.host_chip_budget)}</span>
             <span style="color:var(--text-dim)">Used:</span>
             <span style="color:${(h.host_chips_used||0) >= (h.host_chip_budget||0) ? 'var(--red)' : 'var(--gold)'}">$${fmt(h.host_chips_used||0)}</span>
             <span style="color:var(--text-dim)">Remaining:</span>
             <span style="color:var(--chip-green)">$${fmt(Math.max(0,(h.host_chip_budget||0)-(h.host_chips_used||0)))}</span>`
          : '<span style="color:var(--text-dim)">Unlimited</span>'
        }
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

// ─── Host Budget ─────────────────────────────────────────────────────────

function openHostBudgetModal(hostId, hostUsername, currentBudget, currentUsed) {
  const newBudget = prompt(
    `Set chip budget for ${hostUsername}.\n` +
    `Current: $${fmt(currentBudget)} budget / $${fmt(currentUsed)} used.\n` +
    `Enter new budget amount (0 = unlimited):`,
    currentBudget
  );
  if (newBudget === null) return;
  const budget = parseInt(newBudget) || 0;
  const resetUsed = budget > 0 && confirm(`Also reset the used-chips counter ($${fmt(currentUsed)}) to $0?`);
  apiFetch(`/api/admin/hosts/${hostId}/budget`, { method: 'POST', body: { budget, reset_used: resetUsed } })
    .then(() => { toast(`Budget set to $${fmt(budget)} for ${hostUsername}`); loadHosts(); })
    .catch(e => toast(e.message, 'error'));
}

async function viewHostTransactions(hostId, hostUsername) {
  try {
    const txs = await apiFetch(`/api/admin/hosts/${hostId}/transactions`);
    if (!txs.length) { alert(`No chip-add transactions found for ${hostUsername}.`); return; }
    const lines = txs.slice(0, 50).map(t => {
      const d = new Date(t.created_at).toLocaleString();
      const target = t.username || t.user_id?.slice(0,8) || '?';
      return `${d}  +$${fmt(t.amount)} → ${target}  [${t.table_name || 'no table'}]`;
    });
    const total = txs.reduce((s, t) => s + (t.amount || 0), 0);
    alert(`Chip log for ${hostUsername} (${txs.length} transactions, total $${fmt(total)}):\n\n${lines.join('\n')}`);
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

    let deliveryHtml = '';
    if (m.delivery) {
      const d = m.delivery;
      const emailRows = (d.emails || []).map(u =>
        `<tr><td style="padding:2px 8px;color:var(--text)">${esc(u.username)}${u.nickname ? ` <span style="color:var(--text-dim)">"${esc(u.nickname)}"</span>` : ''}</td><td style="padding:2px 8px;color:#7ec8e3">${esc(u.email)}</td></tr>`
      ).join('');
      const phoneRows = (d.phones || []).map(u =>
        `<tr><td style="padding:2px 8px;color:var(--text)">${esc(u.username)}${u.nickname ? ` <span style="color:var(--text-dim)">"${esc(u.nickname)}"</span>` : ''}</td><td style="padding:2px 8px;color:#a8e6a3">${esc(u.phone)}</td></tr>`
      ).join('');
      deliveryHtml = `
        <div style="margin-top:8px;font-size:.75rem">
          <details style="cursor:pointer">
            <summary style="color:var(--text-dim);list-style:none;outline:none">
              ✉️ ${d.emailCount || 0} emails · 📱 ${d.smsCount || 0} SMS — <span style="text-decoration:underline">show recipients</span>
            </summary>
            <div style="margin-top:6px;background:rgba(0,0,0,.3);border-radius:6px;padding:8px;overflow-x:auto">
              ${emailRows ? `<div style="color:var(--gold);font-size:.72rem;margin-bottom:4px">EMAILS</div><table style="border-collapse:collapse;width:100%">${emailRows}</table>` : ''}
              ${phoneRows ? `<div style="color:var(--gold);font-size:.72rem;margin:8px 0 4px">SMS</div><table style="border-collapse:collapse;width:100%">${phoneRows}</table>` : ''}
              ${!emailRows && !phoneRows ? '<span style="color:var(--text-dim)">No email or SMS recipients</span>' : ''}
            </div>
          </details>
        </div>`;
    }

    return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <div style="color:var(--text-dim);font-size:.75rem;margin-bottom:4px">To: ${targetLabel} · From: <strong>${esc(m.from)}</strong> · ${time}</div>
          <div style="color:var(--text);font-size:.88rem">${esc(m.message)}</div>
          ${deliveryHtml}
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
      const d = result.delivered || 0;
      const q = result.queued || 0;
      const e = result.emailsSent || 0;
      const s = result.smsSent || 0;
      const parts = [`${d} via app`];
      if (q > 0) parts.push(`${q} queued`);
      if (e > 0) parts.push(`${e} emails`);
      if (s > 0) parts.push(`${s} SMS`);
      status.textContent = `Message delivered — ${parts.join(' · ')}`;
      setTimeout(() => { status.textContent = ''; }, 8000);
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
    const gameLabel = r.game_type === 'plo' ? 'PLO' : "Hold'em";
    const hostLabel = r.host_username
      ? `${esc(r.host_username)} <span style="color:var(--text-dim);font-size:.75rem">(${r.host_type === 'admin' ? 'admin' : 'host'})</span>`
      : '<span style="color:var(--text-dim)">No host</span>';
    return `
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div>
            <div style="color:var(--gold);font-weight:700;font-size:1rem">🃏 ${esc(r.table_name)} <span style="color:var(--text-dim);font-size:.78rem;font-weight:400">— ${gameLabel}</span></div>
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
          <div style="color:var(--text-dim);font-size:.78rem;margin-top:3px">${new Date(report.created_at).toLocaleString()} · ${report.game_type === 'plo' ? 'PLO' : "Texas Hold'em"}</div>
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
  if (name === 'banned')   loadBannedPlayers();
  if (name === 'reports')  loadSessionReports();
  if (name === 'finance')  loadFinancialDashboard();
  if (name === 'alerts')   loadFailedLogins();
  if (name === 'tables')   setTimeout(loadWaitlists, 400);
  if (name === 'clips')    loadAdminClips();
}

// ─── Players ──────────────────────────────────────────────────────────────

async function loadPlayers() {
  try {
    allPlayers = await apiFetch('/api/admin/players');
    renderPlayers(allPlayers);
    document.getElementById('stat-players').textContent = allPlayers.length;
    populateRecipientSelector();
    populatePromoteSelector();
    _loadNoteCounts();
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
    <tr style="cursor:pointer" onclick="viewPlayer('${p.id}')" data-player-id="${p.id}">
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

    // 2FA controls (admin/host accounts only)
    _currentPdPlayerId = id;
    const is2FAAccount = p.is_admin || p.is_host;
    const pd2faBtn = document.getElementById('pd-2fa-btn');
    const pd2faUnlockBtn = document.getElementById('pd-2fa-unlock-btn');
    const pdBackupBtn = document.getElementById('pd-backup-btn');
    if (pd2faBtn) {
      if (is2FAAccount) {
        pd2faBtn.style.display = '';
        const enabled = p.two_fa_enabled !== false;
        pd2faBtn.textContent = enabled ? '🔒 Disable 2FA' : '🔓 Enable 2FA';
        pd2faBtn.className = `btn ${enabled ? 'btn-red' : 'btn-green'}`;
      } else {
        pd2faBtn.style.display = 'none';
      }
    }
    if (pd2faUnlockBtn) {
      const isLocked = p.two_fa_locked_until && new Date(p.two_fa_locked_until) > new Date();
      pd2faUnlockBtn.style.display = (is2FAAccount && isLocked) ? '' : 'none';
    }
    if (pdBackupBtn) {
      pdBackupBtn.style.display = is2FAAccount ? '' : 'none';
    }

    // Add 2FA status row to profile grid
    if (is2FAAccount) {
      const enabled = p.two_fa_enabled !== false;
      const isLocked = p.two_fa_locked_until && new Date(p.two_fa_locked_until) > new Date();
      const statusText = isLocked ? '🔴 Locked' : enabled ? '🟢 Enabled' : '⚪ Disabled';
      const gridEl = document.getElementById('pd-grid');
      if (gridEl) {
        gridEl.innerHTML += `<div class="pd-row"><span class="pd-label">2FA</span><span class="pd-value">${statusText}</span></div>`;
      }
    }

    // Always start on Profile tab and pre-load all tabs in background
    pdSwitchTab('profile');
    openModal('player-detail-modal');
    _loadPlayerLogs(id);
    _loadPlayerLoginHistory(id);
    _loadPlayerNotes(id);
  } catch (e) { toast(e.message, 'error'); }
}

function pdSwitchTab(tab) {
  ['profile', 'logs', 'login', 'notes'].forEach(t => {
    const panel = document.getElementById(`pd-panel-${t}`);
    const btn   = document.getElementById(`pd-tab-${t}`);
    if (!panel || !btn) return;
    const active = t === tab;
    panel.style.display = active ? '' : 'none';
    btn.style.borderBottomColor = active ? 'var(--gold)' : 'transparent';
    btn.style.color = active ? 'var(--gold)' : 'var(--text-dim)';
    btn.style.fontWeight = active ? '700' : '600';
  });
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

async function _loadPlayerLoginHistory(playerId) {
  const listEl = document.getElementById('pd-login-list');
  if (!listEl) return;
  try {
    const rows = await apiFetch(`/api/admin/players/${playerId}/login-history`);
    if (!rows.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:20px">No login history.</div>';
      return;
    }
    listEl.innerHTML = rows.map(r => {
      const dt = r.created_at ? new Date(r.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }) : '–';
      const icon  = r.success ? '✅' : '❌';
      const color = r.success ? 'var(--chip-green)' : 'var(--red)';
      const label = r.success ? 'Success' : `Failed — ${esc(r.failure_reason || 'unknown')}`;
      return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:.82rem">
        <span style="font-size:1rem;margin-top:1px">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:${color}">${label}</div>
          <div style="color:var(--text-dim);font-size:.75rem">${esc(r.ip_address)} · ${dt}</div>
          ${r.user_agent ? `<div style="color:var(--text-dim);font-size:.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.user_agent)}">${esc(r.user_agent.slice(0, 70))}${r.user_agent.length > 70 ? '…' : ''}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:20px">Could not load login history.</div>`;
  }
}

async function loadFailedLogins() {
  const listEl = document.getElementById('failed-logins-list');
  if (!listEl) return;
  try {
    const { entries: records, suspicious } = await apiFetch('/api/admin/login-audit?fail=1&limit=30');
    if (!records.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:.82rem;text-align:center;padding:12px">No recent failed logins.</div>';
      return;
    }
    const suspiciousIds = new Set((suspicious || []).map(s => s.userId));
    listEl.innerHTML = records.map(r => {
      const dt = r.created_at ? new Date(r.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }) : '–';
      const isSus = r.user_id && suspiciousIds.has(r.user_id);
      return `<div style="display:flex;align-items:flex-start;gap:10px;padding:7px 10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:.8rem${isSus ? ';border-left:3px solid var(--red)' : ''}">
        <span style="font-size:.95rem;margin-top:1px">❌</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text)">${esc(r.username)}${isSus ? ' <span style="color:var(--red);font-size:.72rem">⚠ SUSPICIOUS</span>' : ''}</div>
          <div style="color:var(--text-dim);font-size:.75rem">${esc(r.ip_address)} · ${dt}</div>
          <div style="color:var(--text-dim);font-size:.73rem">${esc(r.failure_reason || '')}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:.82rem;text-align:center;padding:12px">Could not load failed logins.</div>`;
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
  let ban_reason = null;
  if (banned) {
    ban_reason = prompt('Reason for ban (optional — saved to record and visible in admin panel):') || null;
  }
  try {
    await apiFetch(`/api/admin/players/${id}/ban`, { method: 'POST', body: { banned, ban_reason } });
    toast(banned ? 'Player banned' : 'Player unbanned');
    loadPlayers();
    if (document.getElementById('panel-banned')?.classList.contains('active')) loadBannedPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadBannedPlayers() {
  const el = document.getElementById('banned-players-body');
  if (!el) return;
  el.innerHTML = '<tr><td colspan="7" style="color:var(--text-dim);text-align:center;padding:16px">Loading…</td></tr>';
  try {
    const list = await apiFetch('/api/admin/banned-players');
    renderBannedPlayers(list);
  } catch (e) {
    el.innerHTML = `<tr><td colspan="7" style="color:var(--red);text-align:center;padding:16px">${esc(e.message)}</td></tr>`;
  }
}

function renderBannedPlayers(list) {
  const el = document.getElementById('banned-players-body');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<tr><td colspan="7" style="color:var(--text-dim);text-align:center;padding:16px">No banned players.</td></tr>';
    const badge = document.getElementById('banned-count-badge');
    if (badge) badge.textContent = '';
    return;
  }
  const badge = document.getElementById('banned-count-badge');
  if (badge) badge.textContent = `(${list.length})`;
  el.innerHTML = list.map(p => {
    const bannedDate = p.banned_at ? new Date(p.banned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
    return `<tr>
      <td>${esc(p.username || '–')}</td>
      <td>${esc(p.full_name || '–')}</td>
      <td>${esc(p.nickname || '–')}</td>
      <td>${esc(p.phone || '–')}</td>
      <td>${esc(p.email || '–')}</td>
      <td>${bannedDate}</td>
      <td style="max-width:180px;word-break:break-word">${esc(p.ban_reason || '–')}</td>
      <td><button class="btn btn-sm btn-green" onclick="toggleBan('${p.id}', false)">Unban</button></td>
    </tr>`;
  }).join('');
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

const FELT_COLORS = [
  { color: '#1a5c2a', label: 'Classic' },
  { color: '#0a1628', label: 'Midnight' },
  { color: '#4a0a0a', label: 'Deep Red' },
  { color: '#2a0a4a', label: 'Purple' },
  { color: '#0a0a0a', label: 'Black' },
  { color: '#0a3a3a', label: 'Teal' }
];

function renderLiveTableOverview(tables) {
  const grid = document.getElementById('live-tables-grid');
  if (!grid) return;
  if (!tables || !tables.length) {
    grid.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem">No active tables</div>';
    return;
  }
  grid.innerHTML = tables.map(t => {
    const streetLabel = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' }[t.currentStreet] || '—';
    const playerRows = t.players.map(p =>
      `<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <span style="color:${p.hasFolded ? '#666' : 'var(--text)'}">🪑${p.seatNumber} ${esc(p.username)}</span>
        <span style="color:var(--gold)">$${fmt(p.chips)}</span>
      </div>`
    ).join('');
    return `
      <div class="live-table-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:700;color:var(--gold);font-size:.9rem">${esc(t.tableName)}</span>
          <span style="font-size:.72rem;color:var(--text-dim)">${t.gameType === 'plo' ? 'PLO' : "Hold'em"} $${t.smallBlind}/$${t.bigBlind}</span>
        </div>
        <div style="display:flex;gap:12px;font-size:.78rem;margin-bottom:8px;flex-wrap:wrap">
          <span>👥 <strong>${t.playerCount}</strong> players</span>
          <span style="color:${t.handActive ? 'var(--chip-green)' : 'var(--text-dim)'}">
            ${t.handActive ? `🃏 ${streetLabel}` : '⏸ Waiting'}
          </span>
          ${t.pot > 0 ? `<span>💰 Pot: <strong>$${fmt(t.pot)}</strong></span>` : ''}
          <span style="color:var(--text-dim)">Hand #${t.handNumber}</span>
        </div>
        <div style="margin-bottom:8px;max-height:120px;overflow-y:auto">${playerRows || '<div style="color:var(--text-dim);font-size:.78rem">No players seated</div>'}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:.75rem;color:var(--text-dim);border-top:1px solid rgba(255,255,255,.08);padding-top:6px;gap:6px;flex-wrap:wrap">
          <span>Hands: ${t.handsThisSession} | Rake: $${fmt(t.rakeThisSession)}</span>
          <div style="display:flex;gap:4px">
            ${t.isPaused
              ? `<button class="btn btn-sm btn-gold" style="font-size:.7rem;padding:2px 8px" onclick="adminResumeTable('${t.tableId}')">▶ Resume</button>`
              : `<button class="btn btn-sm" style="font-size:.7rem;padding:2px 8px;background:#555" onclick="adminPauseTable('${t.tableId}')">⏸ Pause</button>`
            }
            <button class="btn btn-sm btn-outline" style="font-size:.7rem;padding:2px 8px" onclick="spectateTable('${t.tableId}')">👁 Spectate</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function spectateTable(tableId) {
  window.open(`/table.html?tableId=${tableId}&spectate=1`, '_blank');
}

function adminPauseTable(tableId) {
  const reason = prompt('Pause reason (optional):', 'Admin pause') ?? '';
  if (reason === null) return;
  adminSocket?.emit('host:pause_game', { tableId, reason: reason.trim() || null });
  toast('Table paused');
}

function adminResumeTable(tableId) {
  adminSocket?.emit('host:resume_game', { tableId });
  toast('Table resumed');
}

function renderTablesAdmin(list) {
  const tbody = document.getElementById('tables-body');
  tbody.innerHTML = list.map(t => {
    const feltColor = t.felt_color || '#1a5c2a';
    const swatches = FELT_COLORS.map(f =>
      `<span class="felt-swatch${f.color === feltColor ? ' selected' : ''}" data-color="${f.color}" style="background:${f.color};width:20px;height:20px;display:inline-block;border-radius:50%;cursor:pointer;border:2px solid ${f.color === feltColor ? 'var(--gold)' : 'transparent'};margin:1px;vertical-align:middle" onclick="patchTableFeltColor('${t.id}','${f.color}')" title="${f.label}"></span>`
    ).join('');
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${t.game_type === 'plo' ? 'PLO' : "Hold'em"}</td>
      <td>$${t.stakes_small_blind}/$${t.stakes_big_blind}</td>
      <td>${t.max_players}</td>
      <td>${t.rake_percent}%</td>
      <td><span style="color:${t.status === 'closed' ? '#888' : 'var(--chip-green)'}">${t.status}</span></td>
      <td><div style="display:flex;align-items:center;gap:4px">${swatches}</div></td>
      <td><div class="actions">
        ${t.status !== 'closed' ? `<button class="btn btn-sm btn-red" onclick="closeTable('${t.id}')">End Session</button>` : ''}
      </div></td>
    </tr>
  `}).join('');
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
        <button class="btn btn-sm btn-red" onclick="closeTable('${t.id}')">End Session</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No active tables</td></tr>';
}

function selectFelt(el, groupId) {
  document.querySelectorAll(`#${groupId} .felt-swatch`).forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function _selectedFelt(groupId) {
  return document.querySelector(`#${groupId} .felt-swatch.selected`)?.dataset.color || '#1a5c2a';
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
        rake_percent: parseFloat(document.getElementById('ct-rake').value),
        felt_color: _selectedFelt('ct-felt-swatches-admin')
      }
    });
    closeModal('create-table-modal');
    toast('Table created');
    loadTables();
  } catch (e) { toast(e.message, 'error'); }
}

async function patchTableFeltColor(tableId, color) {
  try {
    await apiFetch(`/api/admin/tables/${tableId}/felt-color`, { method: 'PATCH', body: { felt_color: color } });
    toast('Felt color updated');
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

let _activeTournamentId = null;
let _activeTournamentName = '';

function renderTournamentsAdmin(list) {
  const tbody = document.getElementById('tournaments-body');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No tournaments</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(t => {
    const players = t.tournament_players?.[0]?.count || 0;
    const statusColor = { registering: 'var(--chip-green)', active: 'var(--red)', completed: '#888' }[t.status] || '#888';
    const isActive = t.status === 'active';
    const isRegistering = t.status === 'registering';
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td style="color:var(--gold)">${fmt(t.buy_in)}</td>
      <td>${fmt(t.starting_chips)}</td>
      <td><span style="color:${statusColor}">${t.status}</span></td>
      <td>${players}</td>
      <td><div class="actions">
        ${isRegistering ? `<button class="btn btn-sm btn-gold" onclick="startTournamentAdmin('${t.id}','${esc(t.name)}')">▶ Start</button>` : ''}
        ${isActive ? `<button class="btn btn-sm btn-outline" onclick="setActiveTournament('${t.id}','${esc(t.name)}')">Controls</button>` : ''}
        <button class="btn btn-sm btn-red" onclick="deleteTournament('${t.id}','${esc(t.name)}')">Delete</button>
      </div></td>
    </tr>`;
  }).join('');

  // Auto-select active tournament
  const active = list.find(t => t.status === 'active');
  if (active) setActiveTournament(active.id, active.name, false);
  else {
    const ctrl = document.getElementById('active-tournament-controls');
    if (ctrl) ctrl.style.display = 'none';
  }
}

function setActiveTournament(id, name, doJoin = true) {
  _activeTournamentId = id;
  _activeTournamentName = name;
  const ctrl = document.getElementById('active-tournament-controls');
  const nameEl = document.getElementById('active-tourn-name');
  if (ctrl) ctrl.style.display = '';
  if (nameEl) nameEl.textContent = name;
  if (doJoin && adminSocket) {
    adminSocket.emit('join_tournament_room', { tournamentId: id });
    adminSocket.emit('tournament_get_standings', { tournamentId: id });
  }
}

async function startTournamentAdmin(id, name) {
  if (!confirm(`Start tournament "${name}"? This cannot be undone.`)) return;
  try {
    adminSocket?.emit('start_tournament', { tournamentId: id });
    adminSocket?.emit('join_tournament_room', { tournamentId: id });
    toast(`Starting tournament ${name}…`);
    setTimeout(loadTournaments, 1500);
  } catch (e) { toast(e.message, 'error'); }
}

function adminCallBreak(minutes) {
  if (!_activeTournamentId) return toast('No active tournament selected', 'error');
  if (!confirm(`Call a ${minutes}-minute break for all players?`)) return;
  adminSocket?.emit('tournament_call_break', { tournamentId: _activeTournamentId, durationMinutes: minutes });
  // Show extend/end buttons
  document.getElementById('adm-break-extend-btn')?.style && (document.getElementById('adm-break-extend-btn').style.display = '');
  document.getElementById('adm-break-end-btn')?.style && (document.getElementById('adm-break-end-btn').style.display = '');
  toast(`☕ ${minutes}-min break called`);
}

function adminExtendBreak() {
  if (!_activeTournamentId) return;
  adminSocket?.emit('tournament_extend_break', { tournamentId: _activeTournamentId, extraMinutes: 5 });
  toast('+5 minutes added to break');
}

function adminEndBreak() {
  if (!_activeTournamentId) return;
  adminSocket?.emit('tournament_end_break', { tournamentId: _activeTournamentId });
  document.getElementById('adm-break-extend-btn')?.style && (document.getElementById('adm-break-extend-btn').style.display = 'none');
  document.getElementById('adm-break-end-btn')?.style && (document.getElementById('adm-break-end-btn').style.display = 'none');
  toast('Break ended');
}

function adminAdvanceTournamentLevel() {
  if (!_activeTournamentId) return toast('No active tournament selected', 'error');
  if (!confirm('Advance to next blind level now?')) return;
  adminSocket?.emit('tournament_advance_level', { tournamentId: _activeTournamentId });
  toast('Blind level advanced');
}

function adminViewStandings() {
  if (!_activeTournamentId) return;
  adminSocket?.emit('tournament_get_standings', { tournamentId: _activeTournamentId });
  document.getElementById('admin-standings-panel').style.display = '';
  document.getElementById('admin-standings-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function adminSpectateTournament() {
  if (!_activeTournamentId) return;
  const tableId = `tournament_${_activeTournamentId}`;
  window.open(`/table.html?tableId=${tableId}&spectate=1`, '_blank');
}

// ─── Blind Schedule Editor ────────────────────────────────────────────────────

const DEFAULT_BLIND_SCHEDULE = [
  { level:1, small_blind:25,  big_blind:50,   duration_minutes:15 },
  { level:2, small_blind:50,  big_blind:100,  duration_minutes:15 },
  { level:3, small_blind:75,  big_blind:150,  duration_minutes:15 },
  { level:4, small_blind:100, big_blind:200,  duration_minutes:15 },
  { level:5, small_blind:150, big_blind:300,  duration_minutes:15 },
  { level:6, small_blind:200, big_blind:400,  duration_minutes:15 },
  { level:7, small_blind:300, big_blind:600,  duration_minutes:15 },
  { level:8, small_blind:500, big_blind:1000, duration_minutes:15 }
];

function initBlindScheduleEditor() {
  const container = document.getElementById('tn-blind-schedule');
  if (!container) return;
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:28px 1fr 1fr 60px 28px;gap:6px;margin-bottom:4px;font-size:.7rem;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:.04em">
      <div>#</div><div>Small Blind</div><div>Big Blind</div><div>Mins</div><div></div>
    </div>
    ${DEFAULT_BLIND_SCHEDULE.map((lvl, i) => _blindLevelRow(i, lvl)).join('')}`;
}

function _blindLevelRow(i, lvl) {
  return `<div id="bsr-${i}" style="display:grid;grid-template-columns:28px 1fr 1fr 60px 28px;gap:6px;align-items:center;margin-bottom:6px;font-size:.82rem">
    <span style="color:var(--text-dim);font-size:.75rem;text-align:center">${i+1}</span>
    <input type="number" value="${lvl.small_blind}" min="1" placeholder="SB" title="Small Blind"
      style="padding:6px 8px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:6px;color:var(--text);width:100%;box-sizing:border-box">
    <input type="number" value="${lvl.big_blind}" min="1" placeholder="BB" title="Big Blind"
      style="padding:6px 8px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:6px;color:var(--text);width:100%;box-sizing:border-box">
    <div style="display:flex;align-items:center;gap:3px">
      <input type="number" value="${lvl.duration_minutes}" min="1" max="60" title="Minutes"
        style="padding:6px 4px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:6px;color:var(--text);width:42px;box-sizing:border-box">
      <span style="color:var(--text-dim);font-size:.7rem">m</span>
    </div>
    <button onclick="removeBlindLevel(${i})" style="background:none;border:1px solid rgba(255,80,80,.4);color:var(--red);border-radius:5px;cursor:pointer;font-size:.75rem;padding:2px 5px">✕</button>
  </div>`;
}

function addBlindLevel() {
  const container = document.getElementById('tn-blind-schedule');
  if (!container) return;
  const rows = _dataRows();
  const count = rows.length;
  const lastRow = rows[count - 1];
  const lastInputs = lastRow ? lastRow.querySelectorAll('input') : [];
  const lastSb = parseInt(lastInputs[0]?.value) || 500;
  const lastBb = parseInt(lastInputs[1]?.value) || 1000;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = _blindLevelRow(count, { small_blind: lastSb * 2, big_blind: lastBb * 2, duration_minutes: 15 });
  container.appendChild(wrapper.firstElementChild);
  _reindexBlindRows();
}

function removeBlindLevel(idx) {
  const rows = _dataRows();
  if (rows.length <= 2) return;
  rows[idx]?.remove();
  _reindexBlindRows();
}

function _dataRows() {
  const container = document.getElementById('tn-blind-schedule');
  if (!container) return [];
  // Skip the header row (first child has no inputs with type=number for blinds)
  return Array.from(container.children).filter(r => r.querySelectorAll('input').length >= 3);
}

function _reindexBlindRows() {
  _dataRows().forEach((row, i) => {
    row.id = `bsr-${i}`;
    const numEl = row.querySelector('span');
    if (numEl) numEl.textContent = i + 1;
    const rmBtn = row.querySelector('button');
    if (rmBtn) rmBtn.setAttribute('onclick', `removeBlindLevel(${i})`);
  });
}

function _readBlindSchedule() {
  return _dataRows().map((row, i) => {
    const inputs = row.querySelectorAll('input');
    return {
      level: i + 1,
      small_blind: parseInt(inputs[0]?.value) || 25,
      big_blind:   parseInt(inputs[1]?.value) || 50,
      duration_minutes: parseInt(inputs[2]?.value) || 15
    };
  });
}

async function createTournamentAdmin() {
  const name = document.getElementById('tn-name-a').value.trim();
  if (!name) return toast('Name required', 'error');
  const schedule = _readBlindSchedule();
  try {
    await apiFetch('/api/tournaments', {
      method: 'POST',
      body: {
        name,
        buy_in: parseInt(document.getElementById('tn-buyin-a').value),
        starting_chips: parseInt(document.getElementById('tn-chips-a').value),
        blind_schedule: schedule || undefined
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

function _admOrdinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

function _renderAdminStandings(standings, prize, activePlayers) {
  const prizeEl = document.getElementById('admin-standings-prize');
  const rowsEl  = document.getElementById('admin-standings-rows');
  if (!rowsEl) return;

  const active = activePlayers ?? (standings || []).filter(s => !s.isEliminated).length;
  if (prizeEl) {
    prizeEl.textContent = prize
      ? `Prize pool: $${prize.toLocaleString()} | ${active} remaining`
      : `${active} player${active !== 1 ? 's' : ''} remaining`;
  }

  rowsEl.innerHTML = (standings || []).map((p, i) => {
    const medal = i === 0 && !p.isEliminated ? '🥇' : i === 1 && !p.isEliminated ? '🥈' : i === 2 && !p.isEliminated ? '🥉' : `${p.rank}`;
    return `<div style="display:grid;grid-template-columns:32px 1fr auto;gap:6px;padding:5px 4px;border-bottom:1px solid rgba(255,255,255,.05);${p.isEliminated?'opacity:.4':''}">
      <span style="text-align:center">${medal}</span>
      <span style="color:${p.isEliminated?'#888':'var(--text)'}${p.isEliminated?';text-decoration:line-through':''}">${esc(p.username)}${p.isEliminated?` <span style="color:var(--red);font-size:.7rem">✗ ${_admOrdinal(p.placement)}</span>`:''}</span>
      <span style="color:${p.isEliminated?'#555':'var(--chip-green)'}">$${p.isEliminated?'—':(p.chips||0).toLocaleString()}</span>
    </div>`;
  }).join('');
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
      tables.filter(t => t.gameType !== 'plo').map(t => `<option value="${t.tableId}" ${t.tableId === cur ? 'selected' : ''}>${esc(t.tableName)}</option>`).join('');
  }

  const container = document.getElementById('jp-tables-list');
  if (!container) return;

  Object.values(tableCountdownIntervals).forEach(clearInterval);
  tableCountdownIntervals = {};

  if (!tables.length) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:.9rem;text-align:center;padding:24px">No Hold\'em tables active. High Hand Jackpot applies to Texas Hold\'em only — PLO tables are excluded.</div>';
    return;
  }

  container.innerHTML = tables.map(t => {
    const hasWinner = t.highHandUsername || t.highHandDescription;
    const rankLabel = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'][t.highHandRank] || '';

    let statusBadge, statusColor, borderColor;
    if (t.awaitingPayout) {
      statusBadge = '⏰ PAYOUT DUE'; statusColor = 'var(--red)'; borderColor = 'var(--red)';
    } else if (t.isOnHold) {
      statusBadge = '⏸ ON HOLD'; statusColor = 'var(--gold)'; borderColor = 'var(--gold)';
    } else if (t.isActive) {
      statusBadge = '✅ ACTIVE'; statusColor = 'var(--chip-green)'; borderColor = 'var(--chip-green)';
    } else {
      statusBadge = '⬛ INACTIVE'; statusColor = 'var(--text-dim)'; borderColor = 'var(--border)';
    }

    let controlButtons = '';
    if (t.awaitingPayout) {
      controlButtons = `
        <button class="btn btn-gold btn-sm" onclick="confirmJackpotPayout('${t.tableId}')">Confirm Payout $${fmt(t.amount)}</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deactivateJackpot('${t.tableId}')">Deactivate (No Pay)</button>`;
    } else if (t.isOnHold) {
      controlButtons = `
        <button class="btn btn-green btn-sm" onclick="controlJackpot('${t.tableId}','resume')">▶ Resume</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deactivateJackpot('${t.tableId}')">Deactivate</button>
        ${t.amount > 0 && hasWinner ? `<button class="btn btn-gold btn-sm" onclick="awardJackpot('${t.tableId}')">Award Manually</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="resetJackpot('${t.tableId}')">Reset $0</button>`;
    } else if (t.isActive) {
      controlButtons = `
        <button class="btn btn-outline btn-sm" style="color:var(--gold);border-color:var(--gold)" onclick="controlJackpot('${t.tableId}','hold')">⏸ Hold</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deactivateJackpot('${t.tableId}')">Deactivate</button>
        ${t.amount > 0 && hasWinner ? `<button class="btn btn-gold btn-sm" onclick="awardJackpot('${t.tableId}')">Award Manually</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="resetJackpot('${t.tableId}')">Reset $0</button>`;
    } else {
      controlButtons = `
        <button class="btn btn-green btn-sm" onclick="controlJackpot('${t.tableId}','activate')">▶ Activate</button>
        ${t.amount > 0 && hasWinner ? `<button class="btn btn-gold btn-sm" onclick="awardJackpot('${t.tableId}')">Award Manually</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="resetJackpot('${t.tableId}')">Reset $0</button>`;
    }

    let timerHtml = '';
    if (t.awaitingPayout) {
      timerHtml = `<div style="color:var(--red);font-weight:700;font-size:1.1rem">PAYOUT DUE</div>`;
    } else if (!t.isActive) {
      timerHtml = `<div style="color:var(--text-dim);font-size:.88rem">Not activated</div>`;
    } else {
      timerHtml = `
        <div style="font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">${t.isOnHold ? 'Paused at' : 'Resets in'}</div>
        <div id="jp-cd-${t.tableId}" style="font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--gold)">–:––</div>`;
    }

    return `
    <div id="jp-table-${t.tableId}" style="background:rgba(255,255,255,.04);border:1px solid ${borderColor};border-radius:var(--radius);padding:18px 20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <div style="font-size:1rem;font-weight:700;color:var(--gold)">🃏 ${esc(t.tableName)}</div>
            <span style="font-size:.7rem;font-weight:700;color:${statusColor};background:rgba(0,0,0,.3);padding:2px 8px;border-radius:10px;border:1px solid ${statusColor};flex-shrink:0">${statusBadge}</span>
          </div>
          <div style="font-size:1.6rem;font-weight:700;color:var(--chip-green)">$${fmt(t.amount)}</div>
          ${hasWinner
            ? `<div style="color:var(--text);margin-top:6px;font-size:.9rem">🏆 <strong>${esc(t.highHandUsername || '—')}</strong> — ${esc(t.highHandDescription || rankLabel)}</div>`
            : `<div style="color:var(--text-dim);margin-top:6px;font-size:.85rem">No high hand recorded</div>`}
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${timerHtml}
          <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            ${controlButtons}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Start live countdowns for active, non-awaiting tables
  tables.forEach(t => {
    if (!t.isActive || t.awaitingPayout) return;
    const frozenMs = t.isOnHold ? (t.timerRemainingMs || 0) : null;
    const deadline = t.timerStart + JACKPOT_INTERVAL_MS;
    const tick = () => {
      const el = document.getElementById(`jp-cd-${t.tableId}`);
      if (!el) { clearInterval(tableCountdownIntervals[t.tableId]); return; }
      const remaining = frozenMs !== null ? frozenMs : Math.max(0, deadline - Date.now());
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
  const label = table ? `${table.tableName} — ${table.highHandUsername || '?'} ($${fmt(table.amount)})` : tableId;
  if (!confirm(`Award jackpot manually for:\n${label}?`)) return;
  try {
    const r = await apiFetch('/api/jackpot/award', { method: 'POST', body: { tableId } });
    toast(`🏆 Jackpot of $${fmt(r.awarded)} awarded to ${table?.highHandUsername || 'winner'}!`);
    loadJackpot();
  } catch (e) { toast(e.message, 'error'); }
}

async function resetJackpot(tableId) {
  if (!confirm('Reset this table\'s jackpot to $0 and clear the high hand?')) return;
  if (adminSocket) adminSocket.emit('admin:action', { action: 'reset_jackpot', tableId });
  toast('Jackpot reset to $0');
  setTimeout(loadJackpot, 500);
}

async function controlJackpot(tableId, action) {
  try {
    await apiFetch('/api/jackpot/control', { method: 'POST', body: { tableId, action } });
    const labels = { activate: '✅ Jackpot activated — 30-min clock started', hold: '⏸ Jackpot paused', resume: '▶ Jackpot resumed' };
    toast(labels[action] || 'Done');
    loadJackpot();
  } catch (e) { toast(e.message || 'Error', 'error'); }
}

async function deactivateJackpot(tableId) {
  const table = currentJackpotTables.find(t => t.tableId === tableId);
  const msg = table?.awaitingPayout
    ? `Deactivate "${table?.tableName}" WITHOUT paying out $${fmt(table?.amount || 0)}?\nThe payout will be lost.`
    : `Deactivate jackpot for "${table?.tableName || tableId}"?\nThe clock stops and no more contributions accumulate.`;
  if (!confirm(msg)) return;
  try {
    await apiFetch('/api/jackpot/control', { method: 'POST', body: { tableId, action: 'deactivate' } });
    toast('Jackpot deactivated');
    loadJackpot();
  } catch (e) { toast(e.message || 'Error', 'error'); }
}

async function confirmJackpotPayout(tableId) {
  const table = currentJackpotTables.find(t => t.tableId === tableId);
  const label = table
    ? `${table.tableName} — ${table.highHandUsername || '?'} ($${fmt(table.amount)})`
    : tableId;
  if (!confirm(`Confirm payout:\n${label}\n\nThis pays the winner and starts a new 30-minute round automatically.`)) return;
  try {
    const r = await apiFetch('/api/jackpot/award', { method: 'POST', body: { tableId } });
    toast(`🏆 $${fmt(r.awarded)} awarded! New 30-min round started.`, 'success');
    loadJackpot();
  } catch (e) { toast(e.message || 'Error', 'error'); }
}

// Handle jackpot expiry notification from server
function handleJackpotExpired(data) {
  const { tableName, awarded, winnerName, winnerHand, tableId } = data;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#0a1a12;border:2px solid var(--gold);border-radius:12px;padding:20px 28px;z-index:9999;text-align:center;min-width:340px;max-width:90vw;box-shadow:0 0 40px rgba(212,175,55,.3)';
  banner.innerHTML = `
    <div style="font-size:1.8rem;margin-bottom:8px">🏆</div>
    <div style="font-weight:700;color:var(--gold);font-size:1.1rem;margin-bottom:4px">Jackpot Expired — ${esc(tableName)}</div>
    <div style="color:var(--text);margin-bottom:4px">${esc(winnerHand || '—')} by <strong>${esc(winnerName || '?')}</strong></div>
    <div style="font-size:1.4rem;font-weight:700;color:var(--chip-green);margin-bottom:8px">$${fmt(awarded)} to award</div>
    <div style="color:var(--text-dim);font-size:.8rem;margin-bottom:14px">After payout, jackpot resets to $0 and a new 30-min round starts automatically.</div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-gold" onclick="confirmJackpotPayout('${tableId}');this.closest('[style*=position]').remove()">Confirm Payout $${fmt(awarded)}</button>
      <button class="btn btn-outline" onclick="this.closest('[style*=position]').remove()">Dismiss (Pay Later)</button>
    </div>`;
  document.body.appendChild(banner);
  loadJackpot();
}

// ─── Admin Chip Refill ────────────────────────────────────────────────────

// ─── Maintenance Banner Toggle ────────────────────────────────────────────────

let _maintBannerActive = false;

async function toggleMaintenanceBanner() {
  try {
    const newState = !_maintBannerActive;
    const r = await apiFetch('/api/admin/maintenance', {
      method: 'POST',
      body: JSON.stringify({ active: newState })
    });
    _maintBannerActive = r.active;
    _updateMaintBtn();
    toast(_maintBannerActive ? 'Maintenance banner enabled' : 'Maintenance banner disabled');
  } catch (e) { toast(e.message, 'error'); }
}

function _updateMaintBtn() {
  const btn = document.getElementById('maint-banner-btn');
  if (!btn) return;
  if (_maintBannerActive) {
    btn.textContent = '✅ Disable Maintenance Banner';
    btn.style.borderColor = 'var(--chip-green)';
    btn.style.color = 'var(--chip-green)';
  } else {
    btn.textContent = '🔧 Enable Maintenance Banner';
    btn.style.borderColor = 'var(--gold)';
    btn.style.color = 'var(--gold)';
  }
}

async function _loadMaintenanceState() {
  try {
    const r = await apiFetch('/api/admin/maintenance');
    _maintBannerActive = r.active;
    _updateMaintBtn();
  } catch {}
}

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

function buyInCardHTML(r, isNew) {
  const nameColor = isNew ? 'var(--chip-green)' : 'var(--text)';
  const prefix = isNew ? '🆕 ' : '';
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div style="flex:1;min-width:180px">
        <div style="font-weight:700;font-size:1rem;color:${nameColor}">${prefix}${esc(r.username)}${r.nickname ? ` <span style="color:var(--text-dim);font-weight:400;font-size:.88rem">(${esc(r.nickname)})</span>` : ''}</div>
        ${r.phone ? `<div style="color:var(--text-dim);font-size:.8rem;margin-top:2px">📱 ${esc(r.phone)}</div>` : ''}
        <div style="color:var(--chip-green);font-size:1.25rem;font-weight:700;margin:4px 0">$${fmt(r.amount)} chips</div>
        <div style="color:var(--text-dim);font-size:.82rem">💳 ${esc(r.paymentMethod)}${r.notes ? ' <span style="opacity:.7">— ' + esc(r.notes) + '</span>' : ''}</div>
        <div style="color:var(--text-dim);font-size:.72rem;margin-top:3px">${new Date(r.requestedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-gold btn-sm" onclick="approveBuyIn(${r.id}, '${esc(r.username)}', ${r.amount})">✓ Add $${fmt(r.amount)} Chips</button>
          <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="denyBuyIn(${r.id})">✗ Deny</button>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--text-dim);cursor:pointer;user-select:none">
          <input type="checkbox" id="bi-paid-${r.id}" ${r.paid ? 'checked' : ''} onchange="markBuyInPaid(${r.id}, this.checked)"
            style="width:15px;height:15px;accent-color:var(--chip-green);cursor:pointer">
          Payment received
        </label>
      </div>
    </div>`;
}

function renderBuyInRequests(requests) {
  const el = document.getElementById('buyin-list');
  if (!el) return;
  if (!requests.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No pending buy-in requests</div>';
    return;
  }
  el.innerHTML = requests.map(r => `
    <div id="bi-${r.id}" style="background:${r.paid ? 'rgba(0,200,80,.06)' : 'rgba(255,255,255,.04)'};border:1px solid ${r.paid ? 'rgba(0,200,80,.35)' : 'var(--border)'};border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;transition:border-color .2s,background .2s">
      ${buyInCardHTML(r, false)}
    </div>`).join('');
}

function prependBuyInRow(r) {
  const el = document.getElementById('buyin-list');
  if (!el) return;
  const empty = el.querySelector('[style*="No pending"]');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.id = `bi-${r.id}`;
  div.style.cssText = 'background:rgba(0,200,80,.08);border:1px solid rgba(0,200,80,.35);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;transition:border-color .2s,background .2s';
  div.innerHTML = buyInCardHTML(r, true);
  el.prepend(div);
}

async function markBuyInPaid(id, paid) {
  try {
    await apiFetch(`/api/admin/buyin-requests/${id}/paid`, { method: 'POST', body: { paid } });
    const el = document.getElementById(`bi-${id}`);
    if (el) {
      el.style.background = paid ? 'rgba(0,200,80,.06)' : 'rgba(255,255,255,.04)';
      el.style.borderColor = paid ? 'rgba(0,200,80,.35)' : 'var(--border)';
    }
  } catch (e) { toast(e.message, 'error'); }
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
    const [list, income] = await Promise.all([
      apiFetch('/api/admin/monthly-fees'),
      apiFetch('/api/admin/fee-income').catch(() => ({ total: 0, monthTotal: 0, unpaidCount: 0 }))
    ]);
    renderMonthlyFees(list);
    _renderFeeIncome(income);
  } catch {}
}

function _renderFeeIncome(income) {
  const overdue = income.unpaidCount || 0;
  const badge = document.getElementById('fees-badge');
  if (badge) { badge.textContent = overdue; badge.style.display = overdue ? '' : 'none'; }
  const monthEl   = document.getElementById('fee-month-total');
  const allEl     = document.getElementById('fee-all-time-total');
  const unpaidEl  = document.getElementById('fee-unpaid-count');
  if (monthEl)  monthEl.textContent  = '$' + fmt(income.monthTotal || 0);
  if (allEl)    allEl.textContent    = '$' + fmt(income.total || 0);
  if (unpaidEl) unpaidEl.textContent = overdue;
  const statFeeIncome = document.getElementById('stat-fee-income');
  const statFeeUnpaid = document.getElementById('stat-fee-unpaid');
  if (statFeeIncome) statFeeIncome.textContent = '$' + fmt(income.monthTotal || 0);
  if (statFeeUnpaid) statFeeUnpaid.textContent = overdue;
}

function renderMonthlyFees(list) {
  const tbody = document.getElementById('fees-body');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-dim)">No fee records yet. Records are created automatically when hosts or admins are approved.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(f => {
    const lastPaid = f.last_paid_at
      ? new Date(f.last_paid_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '—';
    const nextDue = f.next_due_date
      ? new Date(f.next_due_date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '—';
    let statusHtml;
    if (f.fee_suspended) {
      statusHtml = '<span style="background:#6b0000;color:#ff8080;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:8px;border:1px solid #c0392b">SUSPENDED</span>';
    } else if (f.is_overdue) {
      statusHtml = '<span style="background:var(--red);color:#fff;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:8px">OVERDUE</span>';
    } else {
      statusHtml = '<span style="background:rgba(46,204,113,.15);color:var(--chip-green);font-size:.72rem;font-weight:600;padding:2px 7px;border-radius:8px">Paid</span>';
    }
    const roleLabel = f.role_type === 'admin'
      ? '<span style="color:var(--gold);font-size:.8rem;font-weight:700">Admin</span>'
      : '<span style="color:var(--chip-green);font-size:.8rem">Host</span>';
    const methodNote = f.payment_method
      ? `<br><span style="color:var(--text-dim);font-size:.7rem">${esc(f.payment_method)}</span>` : '';
    const rowBg = f.fee_suspended ? 'background:rgba(139,0,0,.1)' : f.is_overdue ? 'background:rgba(255,0,0,.06)' : '';
    const nameColor = f.fee_suspended ? '#ff8080' : f.is_overdue ? 'var(--red)' : 'var(--text)';
    return `<tr style="${rowBg}">
      <td><strong style="color:${nameColor}">${esc(f.username || '—')}</strong></td>
      <td style="color:var(--text-dim);font-size:.82rem">${esc(f.nickname || '—')}</td>
      <td>${roleLabel}</td>
      <td style="color:var(--gold)">$${f.fee_amount}/mo</td>
      <td style="color:var(--text-dim);font-size:.82rem">${lastPaid}${methodNote}</td>
      <td style="color:${f.is_overdue ? 'var(--red)' : 'var(--text-dim)'};font-size:.82rem">${nextDue}</td>
      <td>${statusHtml}</td>
      <td><button class="btn btn-sm btn-green" onclick="openMarkFeePaid('${f.user_id}','${esc(f.username||'')}','${f.fee_amount}')">Mark Paid</button></td>
    </tr>`;
  }).join('');
}

function openMarkFeePaid(userId, username, amount) {
  document.getElementById('mfp-user-id').value = userId;
  document.getElementById('mfp-user-info').textContent = `${username} — $${amount}/month`;
  document.getElementById('mfp-method').value = '';
  document.getElementById('mfp-notes').value = '';
  document.getElementById('mfp-error').textContent = '';
  openModal('mark-fee-paid-modal');
}

async function submitMarkFeePaid() {
  const userId = document.getElementById('mfp-user-id').value;
  const method = document.getElementById('mfp-method').value;
  const notes  = document.getElementById('mfp-notes').value.trim();
  const errEl  = document.getElementById('mfp-error');
  errEl.textContent = '';
  if (!method) { errEl.textContent = 'Please select a payment method'; return; }
  try {
    await apiFetch(`/api/admin/monthly-fees/${userId}/mark-paid`, {
      method: 'POST',
      body: { payment_method: method, notes }
    });
    closeModal('mark-fee-paid-modal');
    toast('Fee marked as paid', 'success');
    loadMonthlyFees();
  } catch (e) { errEl.textContent = e.message; }
}

async function markFeePaid(userId, username) {
  openMarkFeePaid(userId, username, '?');
}

async function sendFeeReminders() {
  if (!confirm('Send email + SMS reminders to all hosts/admins with unpaid fees?')) return;
  try {
    await apiFetch('/api/admin/monthly-fees/send-reminders', { method: 'POST' });
    toast('Reminders sent', 'success');
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

// ─── Password visibility toggle ───────────────────────────────────────────
function togglePw(btn, id) {
  const inp = document.getElementById(id);
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '🙈';
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
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

// ─── Financial Dashboard ──────────────────────────────────────────────────────

let _finData = null;

async function loadFinancialDashboard() {
  try {
    _finData = await apiFetch('/api/admin/financial-summary');
    _renderFinancialStats(_finData);
    _drawRakeChart(_finData.rake?.byDay || []);
    _renderTopTables(_finData.rake?.topTables || []);
    _renderTopPlayers(_finData.topPlayers || []);
  } catch (e) {
    console.warn('[finance] load error:', e.message);
  }
}

function _renderFinancialStats(d) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('fin-rake-alltime',  '$' + fmt(d.rake?.allTime));
  set('fin-rake-month',    '$' + fmt(d.rake?.thisMonth));
  set('fin-rake-week',     '$' + fmt(d.rake?.thisWeek));
  set('fin-rake-today',    '$' + fmt(d.rake?.today));
  set('fin-fees-month',    '$' + fmt(d.fees?.thisMonth));
  set('fin-host-cuts',     '$' + fmt(d.hostCuts?.thisMonth));
  set('fin-net-earnings',  '$' + fmt(d.netEarnings?.thisMonth));
  set('fin-net-alltime',   '$' + fmt(d.netEarnings?.allTime));
}

function _drawRakeChart(byDay) {
  const canvas = document.getElementById('rake-chart');
  if (!canvas || !byDay.length) return;

  // Size canvas to its CSS layout width
  const W = canvas.parentElement?.clientWidth - 32 || 560;
  const H = 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const maxVal = Math.max(...byDay.map(d => d.amount), 1);
  const n = byDay.length;
  const barW   = (W - 4) / n;
  const padTop = 8, padBot = 20;
  const chartH = H - padTop - padBot;
  const todayStr = new Date().toISOString().slice(0, 10);

  const maxEl = document.getElementById('fin-chart-max');
  if (maxEl) maxEl.textContent = `peak $${fmt(maxVal)}`;

  ctx.clearRect(0, 0, W, H);

  byDay.forEach((d, i) => {
    const x = 2 + i * barW;
    const barH = d.amount > 0 ? Math.max(2, (d.amount / maxVal) * chartH) : 1;
    const y = padTop + chartH - barH;
    ctx.fillStyle = d.date === todayStr ? '#f0c040'
      : d.amount > 0 ? 'rgba(46,204,113,.75)'
      : 'rgba(255,255,255,.06)';
    ctx.fillRect(x + 1, y, barW - 2, barH);
  });

  // Date labels every ~10 bars
  ctx.fillStyle = 'rgba(255,255,255,.3)';
  ctx.font = `${9 * Math.min(1, W / 400)}px sans-serif`;
  ctx.textAlign = 'center';
  const interval = Math.ceil(n / 12);
  byDay.forEach((d, i) => {
    if (i % interval !== 0) return;
    const x = 2 + i * barW + barW / 2;
    const [, m, day] = d.date.split('-');
    ctx.fillText(`${m}/${day}`, x, H - 4);
  });

  // Hover tooltip
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const xPos = e.clientX - rect.left;
    const idx  = Math.floor(xPos / barW);
    const tip  = document.getElementById('rake-chart-tooltip');
    if (tip && byDay[idx]) {
      tip.textContent = `${byDay[idx].date}: $${fmt(byDay[idx].amount)}`;
    }
  };
  canvas.onmouseleave = () => {
    const tip = document.getElementById('rake-chart-tooltip');
    if (tip) tip.textContent = '';
  };
}

function _renderTopTables(tables) {
  const el = document.getElementById('fin-top-tables');
  if (!el) return;
  if (!tables.length) { el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:12px">No session data yet</div>'; return; }
  el.innerHTML = tables.map((t, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="color:var(--text)">${i + 1}. ${esc(t.tableName)}</span>
      <div style="text-align:right">
        <span style="color:var(--chip-green);font-weight:600">$${fmt(t.total)}</span>
        <span style="color:var(--text-dim);font-size:.72rem;margin-left:5px">${t.sessions} sess</span>
      </div>
    </div>`).join('');
}

function _renderTopPlayers(players) {
  const el = document.getElementById('fin-top-players');
  if (!el) return;
  if (!players.length) { el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:12px">No buy-in transactions yet</div>'; return; }
  el.innerHTML = players.map((p, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="color:var(--text)">${i + 1}. ${esc(p.username)}</span>
      <span style="color:var(--gold);font-weight:600">$${fmt(p.total)}</span>
    </div>`).join('');
}

async function downloadCSV(type) {
  const from = document.getElementById('export-from')?.value || '';
  const to   = document.getElementById('export-to')?.value   || '';
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  const url = `/api/admin/export/${type}.csv${params.toString() ? '?' + params : ''}`;
  try {
    const token = sessionStorage.getItem('rp_token');
    const resp  = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || 'Export failed'); }
    const blob  = await resp.blob();
    const oUrl  = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href     = oUrl;
    a.download = `${type}${from ? '_' + from : ''}${to ? '_to_' + to : ''}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(oUrl);
    toast(`${type} exported`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function clearExportDates() {
  const f = document.getElementById('export-from');
  const t = document.getElementById('export-to');
  if (f) f.value = '';
  if (t) t.value = '';
}

async function sendWeeklySummary() {
  if (!confirm('Send weekly financial summary email to bostonspokerclub.amitureflops@gmail.com?')) return;
  try {
    await apiFetch('/api/admin/send-weekly-summary', { method: 'POST' });
    toast('Weekly summary emailed', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Player Notes ──────────────────────────────────────────────────────────────

async function _loadPlayerNotes(playerId) {
  const listEl  = document.getElementById('pd-notes-list');
  const badge   = document.getElementById('pd-notes-badge');
  const tabBtn  = document.getElementById('pd-tab-notes');
  if (!listEl) return;
  try {
    const notes = await apiFetch(`/api/admin/players/${playerId}/notes`);
    // Update badge
    if (badge) {
      badge.textContent = notes.length;
      badge.style.display = notes.length ? 'inline' : 'none';
    }
    if (tabBtn) {
      tabBtn.textContent = `📝 Notes${notes.length ? '' : ''}`;
      if (notes.length) {
        tabBtn.innerHTML = `📝 Notes <span style="background:var(--gold);color:#111;font-size:.65rem;font-weight:900;padding:1px 5px;border-radius:10px;margin-left:3px">${notes.length}</span>`;
      }
    }
    if (!notes.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem;text-align:center;padding:20px">No notes yet.</div>';
      return;
    }
    listEl.innerHTML = notes.map(n => `
      <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;position:relative">
        <div style="font-size:.88rem;color:var(--text);line-height:1.5;margin-bottom:6px">${esc(n.note)}</div>
        <div style="font-size:.72rem;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center">
          <span>— ${esc(n.author_username)} · ${new Date(n.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
          <button onclick="deletePlayerNote('${n.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.78rem;padding:0">🗑 Delete</button>
        </div>
      </div>`).join('');
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div style="color:var(--red);font-size:.85rem;text-align:center;padding:20px">${esc(e.message)}</div>`;
  }
}

async function addPlayerNote() {
  if (!_currentPdPlayerId) return;
  const input = document.getElementById('pd-note-input');
  const note  = input?.value.trim();
  if (!note) return;
  try {
    await apiFetch(`/api/admin/players/${_currentPdPlayerId}/notes`, { method: 'POST', body: { note } });
    input.value = '';
    await _loadPlayerNotes(_currentPdPlayerId);
    toast('Note added', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePlayerNote(noteId) {
  if (!_currentPdPlayerId || !confirm('Delete this note?')) return;
  try {
    await apiFetch(`/api/admin/players/${_currentPdPlayerId}/notes/${noteId}`, { method: 'DELETE' });
    await _loadPlayerNotes(_currentPdPlayerId);
    toast('Note deleted');
  } catch (e) { toast(e.message, 'error'); }
}

// Load note counts for the player list and apply badges
async function _loadNoteCounts() {
  try {
    const counts = await apiFetch('/api/admin/players/note-counts');
    document.querySelectorAll('[data-player-id]').forEach(row => {
      const id = row.dataset.playerId;
      const n  = counts[id] || 0;
      let badge = row.querySelector('.note-count-badge');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'note-count-badge';
          badge.style.cssText = 'background:rgba(212,175,55,.2);color:var(--gold);font-size:.65rem;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:4px';
          const nameCell = row.querySelector('td:first-child');
          if (nameCell) nameCell.appendChild(badge);
        }
        badge.textContent = `📝 ${n}`;
      }
    });
  } catch {}
}

// ── Waitlist management ───────────────────────────────────────────────────────

let _waitlistData = {}; // tableId -> [entries]

function loadWaitlists() {
  if (!adminSocket) return;
  // Request waitlist data for each known active table
  allTables.forEach(t => adminSocket.emit('waitlist:admin_view', { tableId: t.id }));
  adminSocket.on('waitlist:admin_data', ({ tableId, list }) => {
    _waitlistData[tableId] = list;
    _renderWaitlists();
  });
}

function _renderWaitlists() {
  const el = document.getElementById('waitlists-body');
  if (!el) return;
  const entries = Object.entries(_waitlistData).filter(([, list]) => list.length > 0);
  if (!entries.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem">No active waiting lists.</div>'; return; }
  el.innerHTML = entries.map(([tableId, list]) => {
    const t = allTables.find(t => t.id === tableId);
    const name = t?.name || tableId;
    const rows = list.map(e => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <span style="font-size:.85rem">#${e.position} <strong>${esc(e.username)}</strong> <span style="color:var(--text-dim);font-size:.75rem">${_waitSince(e.joinedAt)}</span></span>
        <button class="btn btn-sm btn-outline" style="font-size:.72rem;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="adminRemoveWaitlist('${tableId}','${e.userId}')">Remove</button>
      </div>`).join('');
    return `<div style="margin-bottom:16px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
      <div style="font-weight:700;color:var(--gold);font-size:.88rem;margin-bottom:8px">📋 ${esc(name)} — ${list.length} waiting</div>
      ${rows}
    </div>`;
  }).join('');
}

function _waitSince(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function adminRemoveWaitlist(tableId, userId) {
  if (!adminSocket) return;
  adminSocket.emit('waitlist:admin_remove', { tableId, userId });
  setTimeout(loadWaitlists, 300);
}

// ── 2FA admin controls ────────────────────────────────────────────────────────

async function toggle2FA() {
  if (!_currentPdPlayerId) return;
  try {
    const p = allPlayers.find(x => x.id === _currentPdPlayerId);
    const enabled = p ? p.two_fa_enabled !== false : true;
    const action = enabled ? 'disable' : 'enable';
    if (!confirm(`${enabled ? 'Disable' : 'Enable'} 2FA for this account?`)) return;
    await apiFetch(`/api/admin/players/${_currentPdPlayerId}/2fa/${action}`, { method: 'POST' });
    toast(`2FA ${action}d`, 'success');
    closeModal('player-detail-modal');
    await loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function unlock2FA() {
  if (!_currentPdPlayerId) return;
  try {
    await apiFetch(`/api/admin/players/${_currentPdPlayerId}/2fa/unlock`, { method: 'POST' });
    toast('2FA lockout cleared', 'success');
    closeModal('player-detail-modal');
    await loadPlayers();
  } catch (e) { toast(e.message, 'error'); }
}

async function resetPlayerPassword() {
  const id = _currentPdPlayerId;
  if (!id) return;
  let username = '';
  try { username = (await apiFetch(`/api/admin/players/${id}`)).username; } catch {}
  if (!confirm(`Reset password for ${username || 'this player'}? They will receive a temporary password by email and must change it on next login.`)) return;
  try {
    const result = await apiFetch(`/api/admin/players/${id}/reset-password`, { method: 'POST' });
    toast(`Temporary password sent to ${result.email || 'player email'}`);
    closeModal('player-detail-modal');
  } catch (e) { toast(e.message, 'error'); }
}

async function downloadBackupCodes() {
  if (!_currentPdPlayerId) return;
  const p = allPlayers.find(x => x.id === _currentPdPlayerId);
  const name = p ? p.username : _currentPdPlayerId;
  if (!confirm(`Regenerate backup codes for ${name}? This will invalidate all existing codes.`)) return;
  try {
    const data = await apiFetch(`/api/admin/players/${_currentPdPlayerId}/backup-codes/regenerate`, { method: 'POST' });
    const codes = data.codes || [];
    const text = `RabbsRoom Backup Codes — ${name}\nGenerated: ${new Date().toLocaleString()}\n\nStore these in a safe place. Each code can only be used once.\n\n${codes.join('\n')}\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rabbs-backup-codes-${name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`${codes.length} new backup codes generated and downloaded`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Highlight Clips ──────────────────────────────────────────────────────────

async function loadAdminClips() {
  const el = document.getElementById('admin-clips-list');
  if (!el) return;
  try {
    const clips = await apiFetch('/api/highlights');
    if (!clips.length) {
      el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:24px">No clips uploaded yet</div>';
      return;
    }
    el.innerHTML = clips.map(h => `
      <div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
        <video src="${h.video_url}#t=0.1" preload="metadata" style="width:80px;height:50px;object-fit:cover;border-radius:6px;background:#000;flex-shrink:0"></video>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:var(--text);font-size:.9rem">${esc(h.title)}</div>
          <div style="color:var(--text-dim);font-size:.75rem">${h.category} · @${esc(h.uploader_username)} · ❤️ ${h.likes_count}</div>
        </div>
        <button onclick="deleteClip('${h.id}')" style="background:none;border:1px solid var(--red);color:var(--red);padding:3px 10px;border-radius:6px;cursor:pointer;font-size:.75rem;flex-shrink:0">Delete</button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red);padding:16px">${e.message}</div>`;
  }
}

async function deleteClip(id) {
  if (!confirm('Delete this clip permanently?')) return;
  try {
    await apiFetch(`/api/highlights/${id}`, { method: 'DELETE' });
    loadAdminClips();
    toast('Clip deleted');
  } catch (e) { toast(e.message, 'error'); }
}

// Initialize export date range defaults (current month)
(function() {
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const today = now.toISOString().slice(0, 10);
  const fromEl = document.getElementById('export-from');
  const toEl   = document.getElementById('export-to');
  if (fromEl && !fromEl.value) fromEl.value = firstOfMonth;
  if (toEl   && !toEl.value)   toEl.value   = today;
})();
