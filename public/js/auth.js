'use strict';

const API = '';

function getToken() { return localStorage.getItem('rp_token'); }
function getUser() {
  const u = localStorage.getItem('rp_user');
  return u ? JSON.parse(u) : null;
}
function saveAuth(token, user) {
  localStorage.setItem('rp_token', token);
  localStorage.setItem('rp_user', JSON.stringify(user));
}
function clearAuth() {
  localStorage.removeItem('rp_token');
  localStorage.removeItem('rp_user');
}
function requireAuth() {
  if (!getToken()) window.location.href = '/index.html';
}
function logout() {
  clearAuth();
  window.location.href = '/index.html';
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

async function register(username, email, password) {
  const data = await apiFetch('/api/auth/register', { method: 'POST', body: { username, email, password } });
  saveAuth(data.token, data.user);
  return data;
}
