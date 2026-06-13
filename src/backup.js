'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const pool = require('./db');

const TABLES = [
  'users', 'tables', 'table_seats', 'hands', 'hand_actions', 'jackpot',
  'tournaments', 'tournament_players', 'transactions', 'session_reports',
  'monthly_fees', 'monthly_fee_payments', 'player_notes', 'player_stats',
  'messages', 'login_audit', 'table_waitlist', 'highlights',
  'highlight_likes', 'highlight_comments'
];

async function runBackup() {
  console.log('[backup] Starting...');
  const snapshot = { _meta: { backedUpAt: new Date().toISOString(), tables: {} } };
  let totalRows = 0;

  for (const table of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table}`);
      snapshot[table] = rows;
      snapshot._meta.tables[table] = rows.length;
      totalRows += rows.length;
      console.log(`[backup] ${table}: ${rows.length} rows`);
    } catch (err) {
      console.warn(`[backup] SKIP ${table}: ${err.message}`);
      snapshot[table] = [];
      snapshot._meta.tables[table] = 0;
    }
  }

  snapshot._meta.totalRows = totalRows;
  const json = JSON.stringify(snapshot, null, 2);

  // Local rolling backup — Railway filesystem is ephemeral across deploys
  // but files survive restarts, giving a short-term safety net
  try {
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const file    = path.join(dir, `backup-${stamp}.json`);
    fs.writeFileSync(file, json, 'utf8');
    // Keep last 5 only
    const kept = fs.readdirSync(dir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
    while (kept.length > 5) fs.unlinkSync(path.join(dir, kept.shift()));
    console.log(`[backup] Saved locally: ${file}`);
  } catch (err) {
    console.warn('[backup] Local save failed:', err.message);
  }

  // GitHub Gist — durable backup that survives Railway redeployments
  const token = process.env.GITHUB_GIST_TOKEN;
  if (!token) {
    console.warn('[backup] GITHUB_GIST_TOKEN not set — skipping gist upload');
    return;
  }
  try {
    await _pushGist(token, json);
  } catch (err) {
    console.warn('[backup] Gist push failed:', err.message);
  }
}

function _pushGist(token, json) {
  return new Promise((resolve, reject) => {
    const gistId  = process.env.GITHUB_GIST_ID;
    const fname   = 'rabbsroom-db-backup.json';
    const body    = JSON.stringify({
      description: `RabbsRoom DB backup ${new Date().toISOString()}`,
      public: false,
      files: { [fname]: { content: json } }
    });

    const req = https.request({
      hostname: 'api.github.com',
      path:     gistId ? `/gists/${gistId}` : '/gists',
      method:   gistId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':    'rabbsroom-backup/1.0'
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          const parsed = JSON.parse(raw);
          if (!gistId) {
            console.log(`[backup] Gist CREATED id=${parsed.id}  ← set GITHUB_GIST_ID=${parsed.id} in Railway env vars`);
          } else {
            console.log(`[backup] Gist updated: ${gistId}`);
          }
          resolve(parsed);
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function startBackupScheduler() {
  // First backup 3 minutes after boot (let migrations finish)
  setTimeout(() => runBackup().catch(e => console.warn('[backup]', e.message)), 3 * 60 * 1000);
  // Then every 6 hours
  setInterval(() => runBackup().catch(e => console.warn('[backup]', e.message)), 6 * 60 * 60 * 1000);
  console.log('[backup] Scheduler started — first run in 3 min, then every 6 h');
}

module.exports = { startBackupScheduler, runBackup };
