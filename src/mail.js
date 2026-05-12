'use strict';

const nodemailer = require('nodemailer');

const ADMIN_EMAIL = 'bostonspokerclub.amitureflops@gmail.com';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user, pass }
  });
  return transporter;
}

async function sendTableRequestEmail({ hostName, tableName, gameType, sb, bb, maxPlayers, rake }) {
  const t = getTransporter();
  if (!t) {
    console.log('[mail] SMTP not configured — skipping table request email');
    return;
  }
  const displayName = tableName || `${hostName}'s Table`;
  const gameLabel = gameType === 'plo' ? 'PLO' : "Texas Hold'em";
  try {
    await t.sendMail({
      from: `"RabbsRoom" <${process.env.SMTP_USER}>`,
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
  const t = getTransporter();
  if (!t) {
    console.log('[mail] SMTP not configured — skipping broadcast email');
    return 0;
  }
  let sent = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    try {
      await t.sendMail({
        from: `"RabbsRoom" <${process.env.SMTP_USER}>`,
        to: r.email,
        subject: `📨 Message from ${from} — RabbsRoom`,
        text: `Hi ${r.username || 'there'},\n\n${from} sent a message:\n\n"${message}"\n\nLog in at https://rabbsroom.com to respond or view more messages.`,
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

module.exports = { sendTableRequestEmail, sendBroadcastEmail };
