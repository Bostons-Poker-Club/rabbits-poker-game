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
  console.log(`[mail] Sending admin email → ${ADMIN_EMAIL} | ${subject}`);
  try {
    await sgMail.send({ from: FROM, to: ADMIN_EMAIL, subject, text, html });
    console.log(`[mail] Admin email delivered to ${ADMIN_EMAIL}: ${subject}`);
  } catch (e) {
    console.warn(`[mail] Admin email FAILED to ${ADMIN_EMAIL}: ${e.message}`);
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
  if (digits.length !== 10) { console.warn(`[mail] SMS skipped — invalid phone "${phone}"`); return; }
  const smsTo = `${digits}@vtext.com`;
  console.log(`[mail] Sending SMS → ${smsTo}`);
  try {
    await sgMail.send({ from: FROM, to: smsTo, subject: 'RabbsRoom', text });
    console.log(`[mail] SMS delivered to ${smsTo}`);
  } catch (e) {
    console.warn(`[mail] SMS FAILED to ${smsTo}: ${e.message}`);
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

async function sendSessionReportEmail({ reportId, tableName, gameType, totalRake, potVolume, handsPlayed, hostUsername, hostType, hostPercent, hostAmount, houseAmount, hands }) {
  if (!isConfigured()) return;
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

  const textLines = [
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
  ].join('\n');

  const html = `
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
    </div>`;

  try {
    await sgMail.send({
      from: FROM, to: ADMIN_EMAIL,
      subject: `📊 Session Report — ${tableName} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (${handsPlayed} hands, $${fmt(totalRake)} rake)`,
      text: textLines, html
    });
    console.log(`[mail] Session report emailed for ${tableName}`);
  } catch (e) {
    console.warn('[mail] Failed to send session report email:', e.message);
  }
}

async function sendHostSessionEmail({ to, hostUsername, tableName, gameType, handsPlayed, totalRake, hostPercent, hostAmount, houseAmount, reportId }) {
  if (!isConfigured() || !to) return;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fmt = n => (n || 0).toLocaleString();
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  const subject = `Your rake earnings — ${tableName} session — Boston Poker Club`;
  const text = [
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
  ].join('\n');
  const html = `
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
    </div>`;
  try {
    await sgMail.send({ from: FROM, to, subject, text, html });
    console.log(`[mail] Host session email sent to ${to} for ${tableName}`);
  } catch (e) {
    console.warn('[mail] Failed to send host session email:', e.message);
  }
}

async function sendFeeReminderEmail({ to, username, amount, subject, message }) {
  if (!isConfigured() || !to) return;
  try {
    await sgMail.send({
      from: FROM, to, subject,
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
    console.log(`[mail] Fee reminder sent to ${to}`);
  } catch (e) {
    console.warn('[mail] Failed to send fee reminder:', e.message);
  }
}

async function sendFeeReminderSMS({ phone, text }) {
  return sendPlayerSMS({ phone, text });
}

async function sendWeeklySummaryEmail({ from, to, sessions, totalRake, hostCuts, houseRake, feesCollected, netEarnings, tableMap, feePayments }) {
  if (!isConfigured()) return;
  const fmtN = n => (n || 0).toLocaleString();
  const subject = `📊 Weekly Financial Summary — Boston Poker Club (${from} to ${to})`;

  const tableRows = Object.entries(tableMap || {})
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, v]) => `  ${name}: $${fmtN(v.total)} (${v.sessions} session${v.sessions !== 1 ? 's' : ''})`)
    .join('\n');

  const text = [
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
    tableRows ? `Rake by Table:\n${tableRows}` : 'No sessions this week.',
    feePayments?.length
      ? `\nFee Payments:\n${feePayments.map(f => `  ${f.username}: $${f.amount}`).join('\n')}`
      : '',
    '',
    '— Boston Poker Club Admin System'
  ].filter(l => l !== undefined).join('\n');

  const tableHtml = Object.entries(tableMap || {})
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, v]) => `<tr><td style="padding:6px 12px">${name}</td><td style="padding:6px 12px;text-align:right;color:#1a7a3f;font-weight:600">$${fmtN(v.total)}</td><td style="padding:6px 12px;text-align:right;color:#888">${v.sessions}</td></tr>`)
    .join('');

  const feesHtml = (feePayments || []).length
    ? `<h3 style="color:#a07800;margin:18px 0 8px">Fee Payments This Week</h3>
       <table style="border-collapse:collapse;width:100%;font-size:.88rem">
         ${feePayments.map(f => `<tr style="border-bottom:1px solid #eee"><td style="padding:5px 10px">${f.username}</td><td style="padding:5px 10px;text-align:right;color:#a07800;font-weight:600">$${fmtN(f.amount)}</td></tr>`).join('')}
       </table>` : '';

  const html = `
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

      ${tableHtml ? `
      <h3 style="color:#333;margin-bottom:8px">Rake by Table</h3>
      <table style="border-collapse:collapse;width:100%;font-size:.88rem;margin-bottom:18px">
        <thead><tr style="background:#1a7a3f;color:#fff">
          <th style="padding:7px 12px;text-align:left">Table</th>
          <th style="padding:7px 12px;text-align:right">Rake</th>
          <th style="padding:7px 12px;text-align:right">Sessions</th>
        </tr></thead>
        <tbody>${tableHtml}</tbody>
      </table>` : '<p style="color:#888">No sessions this week.</p>'}

      ${feesHtml}

      <p style="color:#999;font-size:.8rem;margin-top:24px">— Boston Poker Club Admin System · auto-generated report</p>
    </div>`;

  try {
    await sgMail.send({ from: FROM, to: ADMIN_EMAIL, subject, text, html });
    console.log('[mail] Weekly summary sent');
  } catch (e) {
    console.warn('[mail] Failed to send weekly summary:', e.message);
  }
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

module.exports = { sendTableRequestEmail, sendBroadcastEmail, sendAdminEmail, sendPlayerEmail, sendPlayerSMS, sendHostApprovalEmail, sendSessionReportEmail, sendHostSessionEmail, sendFeeReminderEmail, sendFeeReminderSMS, sendWeeklySummaryEmail, send2FACode };
