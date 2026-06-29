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
  console.log('[backup] ─── Starting backup ───────────────────────────────');
  const snapshot = { _meta: { backedUpAt: new Date().toISOString(), tables: {} } };
  let totalRows = 0;

  for (const table of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table}`);
      snapshot[table] = rows;
      snapshot._meta.tables[table] = rows.length;
      totalRows += rows.length;
      console.log(`[backup]   ${table}: ${rows.length} rows`);
    } catch (err) {
      console.warn(`[backup]   SKIP ${table}: ${err.message}`);
      snapshot[table] = [];
      snapshot._meta.tables[table] = 0;
    }
  }

  snapshot._meta.totalRows = totalRows;
  const json = JSON.stringify(snapshot, null, 2);
  const backedUpAt = snapshot._meta.backedUpAt;
  console.log(`[backup] Snapshot ready — ${totalRows} rows across ${TABLES.length} tables`);

  // ── Local rolling backup ────────────────────────────────────────────────────
  // Railway filesystem is ephemeral across *deploys* but survives *restarts*,
  // giving a short-term safety net.  Do NOT rely on this as the sole copy.
  let localOk = false;
  try {
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = backedUpAt.slice(0, 19).replace(/[T:]/g, '-');
    const file  = path.join(dir, `backup-${stamp}.json`);
    fs.writeFileSync(file, json, 'utf8');
    // Keep last 5 only
    const all = fs.readdirSync(dir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
    while (all.length > 5) fs.unlinkSync(path.join(dir, all.shift()));
    console.log(`[backup] ✔ Local save: ${file}`);
    localOk = true;
  } catch (err) {
    console.error('[backup] ✘ LOCAL SAVE FAILED:', err.message);
  }

  // ── GitHub Gist — durable offsite backup ───────────────────────────────────
  // Survives Railway redeployments and restarts.
  // Required env vars:
  //   GITHUB_GIST_TOKEN — Personal Access Token with `gist` scope
  //                        Create at: https://github.com/settings/tokens/new
  //                        Tick ONLY the "gist" checkbox, set no expiry (or long expiry)
  //   GITHUB_GIST_ID    — (optional) ID of an existing private gist to overwrite.
  //                        Leave unset on first run; the ID is logged and you then
  //                        add it as a Railway env var so subsequent runs update
  //                        the same gist rather than creating a new one each time.
  const token = process.env.GITHUB_GIST_TOKEN;
  if (!token) {
    // !! OPERATOR ACTION REQUIRED !!
    // This message prints every 6 hours until the token is configured.
    // Backups are currently LOCAL ONLY and will be lost on redeploy.
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  [backup] ✘ OFFSITE BACKUP DISABLED — RAILWAY DATA AT RISK  ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    console.error('║  GITHUB_GIST_TOKEN is not set.                               ║');
    console.error('║  Backups are saving to local disk only.                      ║');
    console.error('║  ALL LOCAL FILES ARE DELETED ON EVERY REDEPLOY.             ║');
    console.error('║                                                              ║');
    console.error('║  TO FIX — do both steps in Railway dashboard:               ║');
    console.error('║  1. Go to github.com/settings/tokens/new                    ║');
    console.error('║     Name: "RabbsRoom backup"                                 ║');
    console.error('║     Scope: ✔ gist  (nothing else needed)                    ║');
    console.error('║     Expiration: No expiration (or set a long reminder)       ║');
    console.error('║     Click "Generate token" and copy it                       ║');
    console.error('║  2. Add to Railway: GITHUB_GIST_TOKEN = <token>             ║');
    console.error('║     Optionally also add GITHUB_GIST_ID once first run       ║');
    console.error('║     logs "Gist CREATED id=..." after token is set           ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    _printSummary(localOk, false, 'no token');
    return;
  }

  let gistOk = false;
  try {
    const result = await _pushGist(token, json);
    gistOk = true;
    const gistId = process.env.GITHUB_GIST_ID;
    if (!gistId) {
      // Log prominently so the operator sees the ID to add to Railway
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log(`║  [backup] ✔ GIST CREATED — id=${result.id.padEnd(30)} ║`);
      console.log('║  ACTION: Add to Railway env vars:                            ║');
      console.log(`║    GITHUB_GIST_ID = ${result.id.padEnd(41)} ║`);
      console.log('║  Future backups will overwrite this gist instead of          ║');
      console.log('║  creating a new one each time.                               ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    } else {
      console.log(`[backup] ✔ Gist updated — id=${gistId}`);
    }
  } catch (err) {
    // Upload failed even though the token is set — this must be loud
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  [backup] ✘ GIST UPLOAD FAILED — OFFSITE BACKUP LOST        ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('[backup] Error:', err.message);
    console.error('[backup] Check: token still valid? gist ID correct? GitHub API up?');
    console.error(`[backup] GITHUB_GIST_TOKEN set: YES  |  GITHUB_GIST_ID: ${process.env.GITHUB_GIST_ID || '(not set)'}`);
    console.error('');
  }

  _printSummary(localOk, gistOk, gistOk ? 'ok' : 'upload-failed');
}

function _printSummary(localOk, gistOk, gistStatus) {
  const localLabel = localOk ? '✔ local' : '✘ local-FAILED';
  let gistLabel;
  if (gistStatus === 'ok')             gistLabel = '✔ gist';
  else if (gistStatus === 'no token')  gistLabel = '✘ gist-SKIPPED(no token)';
  else                                 gistLabel = '✘ gist-FAILED';

  const overall = (localOk && gistOk) ? 'SUCCESS' : (localOk ? 'PARTIAL (local only)' : 'FAILED');
  console.log(`[backup] ─── Done: ${overall}  [${localLabel}, ${gistLabel}] ────────────`);
}

function _pushGist(token, json) {
  return new Promise((resolve, reject) => {
    const gistId = process.env.GITHUB_GIST_ID;
    const fname  = 'rabbsroom-db-backup.json';
    const body   = JSON.stringify({
      description: `RabbsRoom DB backup ${new Date().toISOString()}`,
      public: false,
      files: { [fname]: { content: json } }
    });

    const req = https.request({
      hostname: 'api.github.com',
      path:     gistId ? `/gists/${gistId}` : '/gists',
      method:   gistId ? 'PATCH' : 'POST',
      headers: {
        'Authorization':  `token ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'rabbsroom-backup/1.0',
        'Accept':         'application/vnd.github.v3+json'
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`GitHub API returned non-JSON (status ${res.statusCode})`));
          }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out after 30 s'));
    });
    req.write(body);
    req.end();
  });
}

function startBackupScheduler() {
  // First backup 3 minutes after boot (let migrations finish)
  setTimeout(() => runBackup().catch(e => console.error('[backup] Unhandled error:', e)), 3 * 60 * 1000);
  // Then every 6 hours
  setInterval(() => runBackup().catch(e => console.error('[backup] Unhandled error:', e)), 6 * 60 * 60 * 1000);
  console.log('[backup] Scheduler started — first run in 3 min, then every 6 h');
}

module.exports = { startBackupScheduler, runBackup };
