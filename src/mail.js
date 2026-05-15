'use strict';

const sgMail = require('@sendgrid/mail');

const FROM = 'bostonspokerclub.amitureflops@gmail.com';
const ADMIN_EMAIL = 'bostonspokerclub.amitureflops@gmail.com';

function isConfigured() {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[mail] SENDGRID_API_KEY not set — skipping email');
    return false;
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  return true;
}

async function sendTableRequestEmail({ hostName, tableName, gameType, sb, bb, maxPlayers, rake }) {
  if (!isConfigured()) return;
  const displayName = tableName || `${hostName}'s Table`;
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  try {
    await sgMail.send({
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
    console.log(`[mail] Table request email sent for ${hostName} — ${displayName}`);
  } catch (e) {
    console.warn('[mail] Failed to send table request email:', e.message);
  }
}

async function sendBroadcastEmail({ from, message, recipients }) {
  if (!isConfigured()) return 0;
  let sent = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    try {
      await sgMail.send({
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
      sent++;
    } catch (e) {
      console.warn(`[mail] Failed to send broadcast email to ${r.email}:`, e.message);
    }
  }
  console.log(`[mail] Broadcast email sent to ${sent}/${recipients.length} players`);
  return sent;
}

async function sendAdminEmail({ subject, text, html }) {
  if (!isConfigured()) return;
  try {
    await sgMail.send({ from: FROM, to: ADMIN_EMAIL, subject, text, html });
    console.log(`[mail] Admin email sent: ${subject}`);
  } catch (e) {
    console.warn('[mail] Failed to send admin email:', e.message);
  }
}

async function sendPlayerEmail({ to, subject, text, html }) {
  if (!isConfigured() || !to) return;
  try {
    await sgMail.send({ from: FROM, to, subject, text, html });
    console.log(`[mail] Player email sent to ${to}: ${subject}`);
  } catch (e) {
    console.warn('[mail] Failed to send player email:', e.message);
  }
}

// Send SMS via carrier email gateway. phone is a 10-digit string.
// Supports Verizon — uses the vtext.com gateway as default.
async function sendPlayerSMS({ phone, text }) {
  if (!isConfigured() || !phone) return;
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10) return;
  const smsTo = `${digits}@vtext.com`;
  try {
    await sgMail.send({ from: FROM, to: smsTo, subject: 'RabbsRoom', text });
    console.log(`[mail] SMS sent to ${digits}`);
  } catch (e) {
    console.warn('[mail] Failed to send SMS:', e.message);
  }
}

async function sendHostApprovalEmail({ to, hostName, username, password, hostType }) {
  if (!isConfigured() || !to) return;
  const isAdmin = hostType === 'admin';
  const fee = isAdmin ? '$40' : '$20';
  const rakePercent = isAdmin ? '20%' : '40%';
  const role = isAdmin ? 'Admin' : 'Host';
  const subject = `✅ Your ${role} Account is Approved — Boston Poker Club`;
  const text = [
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
  ].join('\n');
  const html = `
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
    </div>`;
  try {
    await sgMail.send({ from: FROM, to, subject, text, html });
    console.log(`[mail] Host approval email sent to ${to}`);
  } catch (e) {
    console.warn('[mail] Failed to send host approval email:', e.message);
  }
}

async function sendSessionReportEmail({ reportId, tableName, totalRake, potVolume, handsPlayed, hostUsername, hostType, hostPercent, hostAmount, houseAmount, hands }) {
  if (!isConfigured()) return;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fmt = n => (n || 0).toLocaleString();
  const hostLabel = hostUsername ? `${hostUsername} (${hostType === 'admin' ? 'Admin' : 'Host'})` : 'No host';

  const handsRows = (hands || []).map(h =>
    `<tr style="border-bottom:1px solid #eee">
      <td style="padding:5px 10px;text-align:center">#${h.handNum || '–'}</td>
      <td style="padding:5px 10px;text-align:right">$${fmt(h.pot)}</td>
      <td style="padding:5px 10px;text-align:right;color:#1a7a3f;font-weight:600">$${fmt(h.rake)}</td>
    </tr>`
  ).join('');

  const textLines = [
    `SESSION REPORT — ${tableName}`,
    `Date: ${date}`,
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
  ].join('\n');

  const html = `
    <div style="font-family:sans-serif;max-width:620px;margin:0 auto">
      <h2 style="color:#1a7a3f">🃏 Session Report — ${tableName}</h2>
      <p style="color:#666;margin-bottom:20px">${date}</p>

      <table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:8px;overflow:hidden;margin-bottom:20px">
        <tr><td style="padding:9px 14px;color:#555;width:200px">Hands Played</td><td style="padding:9px 14px;font-weight:700">${handsPlayed}</td></tr>
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
    </div>`;

  try {
    await sgMail.send({
      from: FROM, to: ADMIN_EMAIL,
      subject: `📊 Session Report — ${tableName} (${handsPlayed} hands, $${fmt(totalRake)} rake)`,
      text: textLines, html
    });
    console.log(`[mail] Session report emailed for ${tableName}`);
  } catch (e) {
    console.warn('[mail] Failed to send session report email:', e.message);
  }
}

module.exports = { sendTableRequestEmail, sendBroadcastEmail, sendAdminEmail, sendPlayerEmail, sendPlayerSMS, sendHostApprovalEmail, sendSessionReportEmail };
