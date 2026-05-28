'use strict';

const API = '';

// Auth state stored in localStorage (persists across refresh/tab-close).
// Falls back to sessionStorage for browsers that block localStorage in private
// mode (old iOS Safari, strict Firefox ETP) — keeps incognito working.
function _lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch (_) {}
  try { sessionStorage.setItem(k, v); } catch (_) {}
}
function _lsGet(k) {
  try {
    const v = localStorage.getItem(k);
    if (v != null) return v;
  } catch (_) {}
  try { return sessionStorage.getItem(k); } catch (_) { return null; }
}
function _lsDel(k) {
  try { localStorage.removeItem(k); } catch (_) {}
  try { sessionStorage.removeItem(k); } catch (_) {}
}

function getToken() { return _lsGet('rp_token'); }

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return {}; }
}

function getUser() {
  const u = _lsGet('rp_user');
  const stored = u ? JSON.parse(u) : null;
  if (!stored) return null;
  // Always derive isAdmin from the JWT payload — source of truth
  const token = getToken();
  const jwt = token ? decodeJwt(token) : {};
  return {
    ...stored,
    isAdmin: !!(jwt.isAdmin || stored.isAdmin || stored.is_admin)
  };
}
function saveAuth(token, user) {
  _lsSet('rp_token', token);
  _lsSet('rp_user', JSON.stringify(user));
}
function clearAuth() {
  _lsDel('rp_token');
  _lsDel('rp_user');
}
function requireAuth() {
  // replace() instead of href so the login page doesn't push onto history —
  // that would let the back button create a redirect loop.
  if (!getToken()) window.location.replace('/index.html');
}
function logout() {
  clearAuth();
  window.location.replace('/index.html');
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function login(username, password) {
  const data = await apiFetch('/api/auth/login', { method: 'POST', body: { username, password } });
  saveAuth(data.token, data.user);
  return data;
}

async function register(username, email, password, nickname, phone, full_name) {
  const data = await apiFetch('/api/auth/register', { method: 'POST', body: { username, email, password, nickname, phone, full_name: full_name || null } });
  saveAuth(data.token, data.user);
  return data;
}

// ─── Session Timeout ──────────────────────────────────────────────────────────
(function _sessionTimeout() {
  const WARN_BEFORE = 5 * 60 * 1000;
  let _timer, _warnTimer, _warnTickInterval, _modalEl;

  function _getTimeout() {
    const user = getUser();
    if (!user) return 0;
    return user.isAdmin ? 4 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  }

  function _createModal() {
    if (_modalEl) return;
    _modalEl = document.createElement('div');
    _modalEl.id = 'session-timeout-modal';
    _modalEl.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.75);z-index:9999;align-items:center;justify-content:center';
    _modalEl.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #3a3a4a;border-radius:12px;padding:32px 28px;max-width:360px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.5)">
        <div style="font-size:2.2rem;margin-bottom:10px">⏱️</div>
        <h3 style="color:#c8a84b;margin:0 0 8px;font-size:1.15rem">Session Expiring Soon</h3>
        <p style="color:#aaa;font-size:.88rem;margin:0 0 20px;line-height:1.5">You'll be automatically logged out in<br><strong id="sto-countdown" style="color:#c8a84b;font-size:1.1rem">5:00</strong> due to inactivity.</p>
        <button id="sto-stay-btn" style="padding:10px 28px;background:#c8a84b;color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:.95rem">Stay Logged In</button>
      </div>`;
    document.body.appendChild(_modalEl);
    document.getElementById('sto-stay-btn').addEventListener('click', _reset);
  }

  function _showWarning() {
    _createModal();
    _modalEl.style.display = 'flex';
    let remaining = WARN_BEFORE;
    const tick = () => {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
      const el = document.getElementById('sto-countdown');
      if (el) el.textContent = `${m}:${s}`;
      remaining -= 1000;
    };
    tick();
    _warnTickInterval = setInterval(tick, 1000);
  }

  function _hideWarning() {
    if (_modalEl) _modalEl.style.display = 'none';
    clearInterval(_warnTickInterval);
  }

  function _doLogout() {
    _hideWarning();
    if (window.socket && typeof window.socket.emit === 'function') {
      try { window.socket.emit('leave_table'); } catch (_) {}
    }
    clearAuth();
    window.location.replace('/index.html?reason=timeout');
  }

  function _reset() {
    clearTimeout(_timer);
    clearTimeout(_warnTimer);
    _hideWarning();
    const timeout = _getTimeout();
    if (!timeout || !getToken()) return;
    _warnTimer = setTimeout(_showWarning, timeout - WARN_BEFORE);
    _timer     = setTimeout(_doLogout, timeout);
  }

  if (getToken()) {
    ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'].forEach(ev => {
      document.addEventListener(ev, _reset, { passive: true });
    });
    _reset();
  }
})();
