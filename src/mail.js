'use strict';

const https    = require('https');
const sgMail   = require('@sendgrid/mail');

const FROM         = 'noreply@rabbsroom.com';
const ADMIN_EMAIL  = 'bostonspokerclub.amitureflops@gmail.com';

// ─── One-time initialisation ──────────────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const CONFIGURED = !!SENDGRID_API_KEY;

console.log('[mail] SendGrid configured:', CONFIGURED, '| from:', FROM, '| key prefix:', SENDGRID_API_KEY.slice(0, 8) || '(none)');

// ─── Twilio SMS ───────────────────────────────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM  = process.env.TWILIO_PHONE       || '';
const TWILIO_OK    = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

let _twilio = null;
if (TWILIO_OK) {
  _twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  console.log('[SMS] Twilio configured | from:', TWILIO_FROM);
} else {
  console.warn('[SMS] Twilio not configured — falling back to email gateways | missing:', [
    !TWILIO_SID   && 'TWILIO_ACCOUNT_SID',
    !TWILIO_TOKEN && 'TWILIO_AUTH_TOKEN',
    !TWILIO_FROM  && 'TWILIO_PHONE'
  ].filter(Boolean).join(', '));
}

if (CONFIGURED) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('[mail] SENDGRID_API_KEY is not set — all emails will be skipped');
}

// ─── Internal send helper ────────────────────────────────────────────────────
async function _send(msg) {
  if (!CONFIGURED) {
    console.warn('[mail] Skipping email (not configured) to:', msg.to, '|', msg.subject);
    return;
  }
  console.log('[mail] Sending email to:', msg.to, '| subject:', msg.subject, '| from:', msg.from);
  try {
    const [response] = await sgMail.send(msg);
    console.log('[mail] SendGrid response:', response.statusCode, '| to:', msg.to,
      '| body:', JSON.stringify(response.body), '| headers:', JSON.stringify(response.headers));
  } catch (e) {
    console.error('[mail] SendGrid FAILED to:', msg.to, '| subject:', msg.subject);
    console.error('[mail] Error message:', e.message);
    if (e.response) {
      console.error('[mail] SendGrid error statusCode:', e.response.status || e.response.statusCode);
      console.error('[mail] SendGrid error body:', JSON.stringify(e.response.body));
    }
  }
}

// ─── ntfy.sh admin push notifications ───────────────────────────────────────
const NTFY_TOPIC = 'bostonpokerclubrabbsroom2025';

async function sendAdminPush(text, title) {
  const body = text.length > 4096 ? text.slice(0, 4093) + '...' : text;
  const headers = {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body)
  };
  if (title) headers['Title'] = title;

  console.log('[ntfy] Sending push to topic:', NTFY_TOPIC, '| title:', title || '(none)', '| text:', body.substring(0, 80));
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'ntfy.sh',
      port: 443,
      path: `/${NTFY_TOPIC}`,
      method: 'POST',
      headers
    }, (res) => {
      console.log('[ntfy] Response status:', res.statusCode);
      res.resume();
      resolve();
    });
    req.on('error', (e) => {
      console.error('[ntfy] Request error:', e.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ─── Startup tests ───────────────────────────────────────────────────────────
async function sendStartupTestSMS() {
  const ts = new Date().toISOString();
  await sendAdminPush(`RabbsRoom server started ${ts} — push notifications active`, 'RabbsRoom Started');
  if (TWILIO_OK) {
    console.log('[SMS] Sending Twilio startup test to +18572308682');
    await sendPlayerSMS({ phone: '+18572308682', text: `RabbsRoom server started ${ts} — Twilio SMS working` });
  }
}

async function sendStartupTestEmail() {
  await _send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: 'Boston Poker Club - Server Started',
    text: `RabbsRoom server started successfully at ${new Date().toISOString()}.\n\nIf you receive this email, SendGrid is configured correctly.\n\n— Boston Poker Club`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a7a3f">✅ RabbsRoom Server Started</h2>
        <p>Server started at <strong>${new Date().toISOString()}</strong>.</p>
        <p style="color:#666">If you received this email, SendGrid is working correctly.</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
      </div>`
  });
}

// ─── Public send functions ────────────────────────────────────────────────────

async function sendTableRequestEmail({ hostName, tableName, gameType, sb, bb, maxPlayers, rake }) {
  const displayName = tableName || `${hostName}'s Table`;
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  await _send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `🎰 Table Request — ${displayName} by ${hostName}`,
    text: [
      `New table request from host: ${hostName}`,
      `Table: ${displayName}`,
      `Game: ${gameLabel}`,
      `Blinds: $${sb}/$${bb}`,
      `Max Players: ${maxPlayers}`,
      `Rake: ${rake}%`,
      '',
      'Log in to the admin panel to approve or deny.'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1a7a3f">🎰 New Table Request — RabbsRoom</h2>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px;overflow:hidden">
          <tr><td style="padding:8px 14px;color:#555;width:140px">Host</td><td style="padding:8px 14px;font-weight:700">${hostName}</td></tr>
          <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Table Name</td><td style="padding:8px 14px;font-weight:700">${displayName}</td></tr>
          <tr><td style="padding:8px 14px;color:#555">Game</td><td style="padding:8px 14px">${gameLabel}</td></tr>
          <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Blinds</td><td style="padding:8px 14px">$${sb} / $${bb}</td></tr>
          <tr><td style="padding:8px 14px;color:#555">Max Players</td><td style="padding:8px 14px">${maxPlayers}</td></tr>
          <tr style="background:#fff"><td style="padding:8px 14px;color:#555">Rake</td><td style="padding:8px 14px">${rake}%</td></tr>
        </table>
        <p style="margin-top:20px;color:#666">Log in to the <a href="https://rabbsroom.com/admin.html" style="color:#1a7a3f">admin panel</a> to approve or deny this request.</p>
      </div>`
  });
}

async function sendBroadcastEmail({ from, message, recipients }) {
  let sent = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    await _send({
      from: FROM,
      to: r.email,
      subject: `📨 Message from ${from} — RabbsRoom`,
      text: `Hi ${r.username || 'there'},\n\n${from} sent a message:\n\n"${message}"\n\nLog in at https://rabbsroom.com to view more messages.`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#1a7a3f">📨 Message from ${from}</h2>
          <p style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:1rem;line-height:1.6">${message.replace(/\n/g, '<br>')}</p>
          <p style="color:#666;font-size:.85rem">Log in to <a href="https://rabbsroom.com" style="color:#1a7a3f">RabbsRoom</a> to see your message inbox.</p>
        </div>`
    });
    if (CONFIGURED) sent++;
  }
  console.log(`[mail] Broadcast: attempted ${recipients.length} recipients, ${sent} queued`);
  return sent;
}

async function sendAdminEmail({ subject, text, html }) {
  await _send({ from: FROM, to: ADMIN_EMAIL, subject, text, html });
}

async function sendPlayerEmail({ to, subject, text, html }) {
  if (!to) return;
  await _send({ from: FROM, to, subject, text, html });
}

function _toE164(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return `+1${digits}`;
}

async function sendPlayerSMS({ phone, text }) {
  if (!phone) { console.warn('[SMS] Skipped — no phone provided'); return; }
  const e164 = _toE164(phone);
  if (!e164) {
    console.warn(`[SMS] Skipped — invalid phone "${phone}" (could not normalise to E.164)`);
    return;
  }

  if (TWILIO_OK) {
    const truncated = text.length > 1600 ? text.slice(0, 1597) + '...' : text;
    console.log('[SMS] Twilio sending | to:', e164, '| text:', truncated.substring(0, 60));
    try {
      const msg = await _twilio.messages.create({ body: truncated, from: TWILIO_FROM, to: e164 });
      console.log('[SMS] Twilio delivered | sid:', msg.sid, '| status:', msg.status, '| to:', e164);
    } catch (e) {
      console.error('[SMS] Twilio error | to:', e164, '| error:', e.message);
    }
    return;
  }

  // Fallback: email-to-SMS gateways when Twilio is not configured
  const digits10  = e164.slice(2); // strip +1
  const truncated = text.length > 160 ? text.slice(0, 157) + '...' : text;
  const subject   = 'RabbsRoom';
  const vtextAddr  = `${digits10}@vtext.com`;
  const vzwpixAddr = `${digits10}@vzwpix.com`;
  const attAddr    = `${digits10}@mms.att.net`;

  console.log('[SMS] Gateway fallback | to:', e164, '| addresses:', vtextAddr, vzwpixAddr, attAddr);

  const results = await Promise.allSettled([
    _send({ from: FROM, to: vtextAddr,  subject, text: truncated }),
    _send({ from: FROM, to: vzwpixAddr, subject, text: truncated }),
    _send({ from: FROM, to: attAddr,    subject, text: truncated })
  ]);
  console.log('[SMS] Gateway results — vtext:', results[0].status, '| vzwpix:', results[1].status, '| att:', results[2].status);
}

async function sendAdminSMS(text) {
  console.log('[SMS] sendAdminSMS | text:', text.substring(0, 50));
  await sendAdminPush(text, 'RabbsRoom Admin');
  if (TWILIO_OK) await sendPlayerSMS({ phone: '+18572308682', text });
}

async function sendHostApprovalEmail({ to, hostName, username, password, hostType }) {
  if (!to) return;
  const isAdmin = hostType === 'admin';
  const fee = isAdmin ? '$40' : '$20';
  const rakePercent = isAdmin ? '20%' : '40%';
  const role = isAdmin ? 'Admin' : 'Host';
  await _send({
    from: FROM,
    to,
    subject: `✅ Your ${role} Account is Approved — Boston Poker Club`,
    text: [
      `Hi ${hostName},`,
      '',
      `Your ${role.toLowerCase()} account has been approved at Boston Poker Club!`,
      '',
      'Login credentials:',
      `  Username: ${username}`,
      `  Password: ${password}`,
      '',
      'Important details:',
      `  • Monthly fee: ${fee} — due by the 1st of each month`,
      `  • Rake share: You keep ${rakePercent} of rake from tables you host`,
      '',
      'Getting started:',
      '  1. Log in at rabbsroom.com',
      '  2. Go to the lobby and request a table',
      '  3. Once approved, your table goes live',
      '  4. Manage players directly from the table controls',
      '',
      'Questions? Contact bostonspokerclub.amitureflops@gmail.com',
      '',
      '— Boston Poker Club'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#1a7a3f">✅ Welcome to Boston Poker Club, ${hostName}!</h2>
        <p>Your <strong>${role.toLowerCase()}</strong> account has been approved.</p>
        <div style="background:#f9f9f9;border-radius:8px;padding:16px 20px;margin:16px 0">
          <h3 style="margin:0 0 10px;color:#333">Login Credentials</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:6px 12px;color:#555;width:120px">Username</td><td style="padding:6px 12px;font-weight:700">${username}</td></tr>
            <tr style="background:#fff"><td style="padding:6px 12px;color:#555">Password</td><td style="padding:6px 12px;font-weight:700">${password}</td></tr>
          </table>
        </div>
        <div style="background:#f0faf5;border:1px solid #b2dfcc;border-radius:8px;padding:16px 20px;margin:16px 0">
          <h3 style="margin:0 0 10px;color:#1a7a3f">Your Account Details</h3>
          <ul style="margin:0;padding-left:20px;color:#333;line-height:2">
            <li><strong>Monthly fee:</strong> ${fee} — due by the 1st of each month</li>
            <li><strong>Rake share:</strong> You keep ${rakePercent} of rake from every table you host</li>
          </ul>
        </div>
        <div style="background:#fff9e6;border:1px solid #f5d78e;border-radius:8px;padding:16px 20px;margin:16px 0">
          <h3 style="margin:0 0 10px;color:#a07800">Getting Started</h3>
          <ol style="margin:0;padding-left:20px;color:#333;line-height:2">
            <li>Log in at <a href="https://rabbsroom.com" style="color:#1a7a3f">rabbsroom.com</a></li>
            <li>Go to the lobby and request a table</li>
            <li>Once your request is approved, your table goes live</li>
            <li>Manage your players directly from the table controls</li>
          </ol>
        </div>
        <p style="color:#666;font-size:.85rem">Questions? Contact us at bostonspokerclub.amitureflops@gmail.com</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
      </div>`
  });
}

async function sendSessionReportEmail({ reportId, tableName, gameType, totalRake, potVolume, handsPlayed, hostUsername, hostType, hostPercent, hostAmount, houseAmount, hands }) {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const fmt = n => (n || 0).toLocaleString();
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  const hostLabel = hostUsername ? `${hostUsername} (${hostType === 'admin' ? 'Admin' : 'Host'})` : 'No host';

  const handsRows = (hands || []).map(h =>
    `<tr style="border-bottom:1px solid #eee">
      <td style="padding:5px 10px;text-align:center">#${h.handNum || '–'}</td>
      <td style="padding:5px 10px;text-align:right">$${fmt(h.pot)}</td>
      <td style="padding:5px 10px;text-align:right;color:#1a7a3f;font-weight:600">$${fmt(h.rake)}</td>
    </tr>`
  ).join('');

  await _send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `📊 Session Report — ${tableName} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (${handsPlayed} hands, $${fmt(totalRake)} rake)`,
    text: [
      `SESSION REPORT — ${tableName}`,
      `Date: ${dateStr} at ${timeStr}`,
      `Game: ${gameLabel}`,
      '',
      `Hands Played: ${handsPlayed}`,
      `Total Pot Volume: $${fmt(potVolume)}`,
      `Total Rake Collected: $${fmt(totalRake)}`,
      '',
      `Host: ${hostLabel}`,
      `Host Cut (${hostPercent}%): $${fmt(hostAmount)}`,
      `House Earnings: $${fmt(houseAmount)}`,
      '',
      'Per-Hand Breakdown:',
      ...(hands || []).map(h => `  Hand #${h.handNum || '–'}  Pot $${fmt(h.pot)}  Rake $${fmt(h.rake)}`),
      '',
      `Report ID: ${reportId || 'N/A'}`
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:620px;margin:0 auto">
        <h2 style="color:#1a7a3f">🃏 Session Report — ${tableName}</h2>
        <p style="color:#666;margin-bottom:4px">${dateStr} at ${timeStr}</p>
        <p style="color:#888;font-size:.88rem;margin-bottom:20px">Game: <strong>${gameLabel}</strong></p>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px;overflow:hidden;margin-bottom:20px">
          <tr><td style="padding:9px 14px;color:#555;width:200px">Table</td><td style="padding:9px 14px;font-weight:700">${tableName}</td></tr>
          <tr style="background:#fff"><td style="padding:9px 14px;color:#555">Game Type</td><td style="padding:9px 14px;font-weight:700">${gameLabel}</td></tr>
          <tr><td style="padding:9px 14px;color:#555">Hands Played</td><td style="padding:9px 14px;font-weight:700">${handsPlayed}</td></tr>
          <tr style="background:#fff"><td style="padding:9px 14px;color:#555">Total Pot Volume</td><td style="padding:9px 14px;font-weight:700">$${fmt(potVolume)}</td></tr>
          <tr><td style="padding:9px 14px;color:#555">Total Rake Collected</td><td style="padding:9px 14px;font-weight:700;color:#1a7a3f">$${fmt(totalRake)}</td></tr>
        </table>
        <h3 style="color:#333;margin-bottom:10px">Rake Split</h3>
        <table style="border-collapse:collapse;width:100%;background:#f0faf5;border:1px solid #b2dfcc;border-radius:8px;overflow:hidden;margin-bottom:20px">
          <tr><td style="padding:9px 14px;color:#555;width:200px">Host</td><td style="padding:9px 14px;font-weight:700">${hostLabel}</td></tr>
          <tr style="background:#e8f5ee"><td style="padding:9px 14px;color:#555">Host Cut (${hostPercent}%)</td><td style="padding:9px 14px;font-weight:700;color:#1a7a3f">$${fmt(hostAmount)}</td></tr>
          <tr><td style="padding:9px 14px;color:#555">House Earnings</td><td style="padding:9px 14px;font-weight:700;color:#1a7a3f">$${fmt(houseAmount)}</td></tr>
        </table>
        ${handsRows ? `
        <h3 style="color:#333;margin-bottom:10px">Per-Hand Breakdown (${handsPlayed} hands)</h3>
        <div style="max-height:400px;overflow-y:auto">
          <table style="border-collapse:collapse;width:100%;font-size:.88rem">
            <thead><tr style="background:#1a7a3f;color:#fff">
              <th style="padding:7px 10px">Hand #</th>
              <th style="padding:7px 10px;text-align:right">Pot</th>
              <th style="padding:7px 10px;text-align:right">Rake</th>
            </tr></thead>
            <tbody>${handsRows}</tbody>
          </table>
        </div>` : ''}
        <p style="color:#999;font-size:.8rem;margin-top:20px">Report ID: ${reportId || 'N/A'} — Boston Poker Club</p>
      </div>`
  });
}

async function sendHostSessionEmail({ to, hostUsername, tableName, gameType, handsPlayed, totalRake, hostPercent, hostAmount, houseAmount, reportId }) {
  if (!to) return;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fmt = n => (n || 0).toLocaleString();
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  await _send({
    from: FROM,
    to,
    subject: `Your rake earnings — ${tableName} session — Boston Poker Club`,
    text: [
      `Hi ${hostUsername},`,
      '',
      `Your session at ${tableName} has ended. Here are your earnings:`,
      '',
      `Table: ${tableName}`,
      `Game: ${gameLabel}`,
      `Date: ${dateStr}`,
      `Hands played: ${handsPlayed}`,
      `Total rake collected: $${fmt(totalRake)}`,
      '',
      `Your cut (${hostPercent}%): $${fmt(hostAmount)}`,
      `House cut: $${fmt(houseAmount)}`,
      '',
      'Thank you for hosting at Boston Poker Club!',
      '— Boston Poker Club'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#1a7a3f">🎰 Session Earnings — ${tableName}</h2>
        <p>Hi <strong>${hostUsername}</strong>,</p>
        <p>Your session at <strong>${tableName}</strong> has ended. Here's a summary of your rake earnings:</p>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px;overflow:hidden;margin:16px 0">
          <tr><td style="padding:9px 14px;color:#555;width:180px">Table</td><td style="padding:9px 14px;font-weight:700">${tableName}</td></tr>
          <tr style="background:#fff"><td style="padding:9px 14px;color:#555">Game</td><td style="padding:9px 14px">${gameLabel}</td></tr>
          <tr><td style="padding:9px 14px;color:#555">Date</td><td style="padding:9px 14px">${dateStr}</td></tr>
          <tr style="background:#fff"><td style="padding:9px 14px;color:#555">Hands Played</td><td style="padding:9px 14px">${handsPlayed}</td></tr>
          <tr><td style="padding:9px 14px;color:#555">Total Rake</td><td style="padding:9px 14px;color:#1a7a3f;font-weight:700">$${fmt(totalRake)}</td></tr>
        </table>
        <div style="background:#f0faf5;border:1px solid #b2dfcc;border-radius:8px;padding:16px 20px;margin:16px 0">
          <div style="font-size:1.15rem;font-weight:700;color:#1a7a3f;margin-bottom:6px">Your Earnings: $${fmt(hostAmount)}</div>
          <div style="color:#555;font-size:.88rem">Your ${hostPercent}% cut of $${fmt(totalRake)} total rake</div>
          <div style="color:#888;font-size:.82rem;margin-top:4px">House cut: $${fmt(houseAmount)}</div>
        </div>
        <p style="color:#666;font-size:.88rem">Contact us at <a href="mailto:bostonspokerclub.amitureflops@gmail.com" style="color:#1a7a3f">bostonspokerclub.amitureflops@gmail.com</a> with any questions.</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club${reportId ? ` · Report #${reportId}` : ''}</p>
      </div>`
  });
}

async function sendFeeReminderEmail({ to, username, amount, subject, message }) {
  if (!to) return;
  await _send({
    from: FROM,
    to,
    subject,
    text: `Hi ${username || 'there'},\n\n${message}\n\nLog in at https://rabbsroom.com to check your account status.\n\n— Boston Poker Club`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#c0392b">💳 Hosting Fee Reminder — Boston Poker Club</h2>
        <p>Hi <strong>${username || 'there'}</strong>,</p>
        <p style="background:#fff9e6;border:1px solid #f5d78e;border-radius:8px;padding:14px 18px;font-size:1rem;line-height:1.6">${message}</p>
        <p style="color:#666;font-size:.85rem">Log in to <a href="https://rabbsroom.com" style="color:#1a7a3f">RabbsRoom</a> to check your account status.</p>
        <p style="color:#999;font-size:.8rem">— Boston Poker Club · bostonspokerclub.amitureflops@gmail.com</p>
      </div>`
  });
}

async function sendFeeReminderSMS({ phone, text }) {
  return sendPlayerSMS({ phone, text });
}

async function sendWeeklySummaryEmail({ from, to, sessions, totalRake, hostCuts, houseRake, feesCollected, netEarnings, tableMap, feePayments }) {
  const fmtN = n => (n || 0).toLocaleString();

  const tableRows = Object.entries(tableMap || {})
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, v]) => `<tr><td style="padding:6px 12px">${name}</td><td style="padding:6px 12px;text-align:right;color:#1a7a3f;font-weight:600">$${fmtN(v.total)}</td><td style="padding:6px 12px;text-align:right;color:#888">${v.sessions}</td></tr>`)
    .join('');

  const feesHtml = (feePayments || []).length
    ? `<h3 style="color:#a07800;margin:18px 0 8px">Fee Payments This Week</h3>
       <table style="border-collapse:collapse;width:100%;font-size:.88rem">
         ${feePayments.map(f => `<tr style="border-bottom:1px solid #eee"><td style="padding:5px 10px">${f.username}</td><td style="padding:5px 10px;text-align:right;color:#a07800;font-weight:600">$${fmtN(f.amount)}</td></tr>`).join('')}
       </table>` : '';

  await _send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `📊 Weekly Financial Summary — Boston Poker Club (${from} to ${to})`,
    text: [
      `WEEKLY FINANCIAL SUMMARY — Boston Poker Club`,
      `Period: ${from} → ${to}`,
      '',
      `Sessions played:          ${sessions}`,
      `Total rake collected:     $${fmtN(totalRake)}`,
      `Host/admin cuts paid out: $${fmtN(hostCuts)}`,
      `House rake earnings:      $${fmtN(houseRake)}`,
      `Monthly fees collected:   $${fmtN(feesCollected)}`,
      '',
      `NET HOUSE EARNINGS:       $${fmtN(netEarnings)}`,
      '',
      Object.entries(tableMap || {}).length
        ? `Rake by Table:\n${Object.entries(tableMap).sort((a,b)=>b[1].total-a[1].total).map(([n,v])=>`  ${n}: $${fmtN(v.total)} (${v.sessions} session${v.sessions!==1?'s':''})`).join('\n')}`
        : 'No sessions this week.',
      (feePayments || []).length
        ? `\nFee Payments:\n${feePayments.map(f=>`  ${f.username}: $${f.amount}`).join('\n')}`
        : '',
      '',
      '— Boston Poker Club Admin System'
    ].filter(Boolean).join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:580px;margin:0 auto">
        <h2 style="color:#1a7a3f">📊 Weekly Financial Summary</h2>
        <p style="color:#666;margin-bottom:20px">Period: <strong>${from}</strong> → <strong>${to}</strong></p>
        <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px;overflow:hidden;margin-bottom:20px">
          <tr><td style="padding:10px 14px;color:#555;width:230px">Sessions Played</td><td style="padding:10px 14px;font-weight:700">${sessions}</td></tr>
          <tr style="background:#fff"><td style="padding:10px 14px;color:#555">Total Rake Collected</td><td style="padding:10px 14px;font-weight:700;color:#1a7a3f">$${fmtN(totalRake)}</td></tr>
          <tr><td style="padding:10px 14px;color:#555">Host / Admin Cuts</td><td style="padding:10px 14px;font-weight:700;color:#c0392b">−$${fmtN(hostCuts)}</td></tr>
          <tr style="background:#fff"><td style="padding:10px 14px;color:#555">House Rake Earnings</td><td style="padding:10px 14px;font-weight:700;color:#1a7a3f">$${fmtN(houseRake)}</td></tr>
          <tr><td style="padding:10px 14px;color:#555">Monthly Fees Collected</td><td style="padding:10px 14px;font-weight:700;color:#a07800">$${fmtN(feesCollected)}</td></tr>
          <tr style="background:#e8f5ee"><td style="padding:10px 14px;color:#333;font-weight:700;font-size:1.05rem">NET HOUSE EARNINGS</td><td style="padding:10px 14px;font-weight:700;color:#1a7a3f;font-size:1.15rem">$${fmtN(netEarnings)}</td></tr>
        </table>
        ${tableRows ? `
        <h3 style="color:#333;margin-bottom:8px">Rake by Table</h3>
        <table style="border-collapse:collapse;width:100%;font-size:.88rem;margin-bottom:18px">
          <thead><tr style="background:#1a7a3f;color:#fff">
            <th style="padding:7px 12px;text-align:left">Table</th>
            <th style="padding:7px 12px;text-align:right">Rake</th>
            <th style="padding:7px 12px;text-align:right">Sessions</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : '<p style="color:#888">No sessions this week.</p>'}
        ${feesHtml}
        <p style="color:#999;font-size:.8rem;margin-top:24px">— Boston Poker Club Admin System · auto-generated report</p>
      </div>`
  });
}

async function send2FACode({ to, phone, username, code }) {
  const subject = `🔐 Your RabbsRoom login code: ${code}`;
  const text    = `Hi ${username},\n\nYour verification code is: ${code}\n\nThis code expires in 5 minutes. Do not share it with anyone.\n\n— Boston Poker Club`;
  const html    = `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto">
      <h2 style="color:#c8a84b">🔐 Login Verification</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>Your verification code is:</p>
      <div style="font-size:2.4rem;font-weight:700;letter-spacing:.18em;color:#1a5c2a;background:#f0faf5;border:2px solid #b2dfcc;border-radius:10px;padding:16px 24px;text-align:center;margin:16px 0">${code}</div>
      <p style="color:#666;font-size:.88rem">This code expires in <strong>5 minutes</strong>. Do not share it.</p>
      <p style="color:#999;font-size:.8rem">— Boston Poker Club</p>
    </div>`;
  await Promise.allSettled([
    to ? sendPlayerEmail({ to, subject, text, html }) : Promise.resolve(),
    phone ? sendPlayerSMS({ phone, text: `RabbsRoom login code: ${code} (expires 5 min)` }) : Promise.resolve()
  ]);
}

module.exports = {
  sendStartupTestEmail,
  sendStartupTestSMS,
  sendAdminPush,
  sendAdminSMS,
  sendTableRequestEmail,
  sendBroadcastEmail,
  sendAdminEmail,
  sendPlayerEmail,
  sendPlayerSMS,
  sendHostApprovalEmail,
  sendSessionReportEmail,
  sendHostSessionEmail,
  sendFeeReminderEmail,
  sendFeeReminderSMS,
  sendWeeklySummaryEmail,
  send2FACode
};
