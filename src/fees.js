'use strict';

const pool = require('./db');

// In-memory set of fee-suspended user IDs for fast auth checks
const feeSuspendedUsers = new Set();

async function _loadFeeSuspended() {
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE fee_suspended = TRUE');
    feeSuspendedUsers.clear();
    rows.forEach(u => feeSuspendedUsers.add(u.id));
  } catch (e) {
    console.warn('[fees] Could not load fee-suspended users:', e.message);
  }
}

async function runDailyFeeCheck() {
  try {
    const today = new Date();
    const day = today.getDate();
    const todayStr = today.toISOString().slice(0, 10);
    console.log(`[fees] Daily check — ${todayStr} (day ${day})`);

    try {
      await pool.query(
        `UPDATE monthly_fees SET is_overdue = TRUE, updated_at = NOW() WHERE next_due_date < $1`,
        [todayStr]
      );
    } catch (e) {
      console.warn('[fees] Overdue update exception:', e.message);
    }

    if (day === 25) await _sendFeeReminders('25th');
    if (day === 1)  await _sendFeeReminders('1st');
    if (day === 5)  await suspendOverdueAccounts();
  } catch (e) {
    console.warn('[fees] runDailyFeeCheck error:', e.message);
  }
}

async function _sendFeeReminders(type) {
  try {
    let mail;
    try { mail = require('./mail'); } catch { return; }
    const col = type === '25th' ? 'reminder_25_sent_at' : 'reminder_1_sent_at';

    const now = new Date();
    const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let fees = [];
    try {
      const { rows } = await pool.query(
        `SELECT user_id, username, fee_amount, role_type FROM monthly_fees
         WHERE ${col} IS NULL OR ${col} < $1`,
        [cycleStart]
      );
      fees = rows;
    } catch (e) {
      console.warn('[fees] _sendFeeReminders select error:', e.message);
      return;
    }

    if (!fees.length) {
      console.log(`[fees] No ${type} reminders to send`);
      return;
    }

    let sent = 0;
    for (const fee of fees) {
      try {
        let user = null;
        try {
          const { rows } = await pool.query(
            'SELECT email, phone FROM users WHERE id = $1',
            [fee.user_id]
          );
          user = rows[0] || null;
        } catch (e) {
          console.warn('[fees] user lookup error:', e.message);
        }
        if (!user?.email) continue;

        const isUrgent = type === '1st';
        const subject = isUrgent
          ? `URGENT: $${fee.fee_amount} hosting fee due today — Boston Poker Club`
          : `Reminder: $${fee.fee_amount} hosting fee due in 6 days — Boston Poker Club`;
        const message = `Boston Poker Club: Your monthly hosting fee of $${fee.fee_amount} is due on the 1st. Pay via CashApp $rabbsroom or Venmo @Roger-Depina`;

        try { await mail.sendFeeReminderEmail({ to: user.email, username: fee.username, amount: fee.fee_amount, subject, message }); } catch {}
        if (user.phone) {
          try { await mail.sendFeeReminderSMS({ phone: user.phone, text: message }); } catch {}
        }

        try {
          await pool.query(
            `UPDATE monthly_fees SET ${col} = NOW() WHERE user_id = $1`,
            [fee.user_id]
          );
        } catch (e) {
          console.warn('[fees] Reminder timestamp update exception:', e.message);
        }

        sent++;
      } catch (e) {
        console.warn('[fees] reminder loop error:', e.message);
      }
    }

    console.log(`[fees] Sent ${type} reminders to ${sent}/${fees.length} hosts/admins`);
  } catch (e) {
    console.warn('[fees] _sendFeeReminders error:', e.message);
  }
}

async function suspendOverdueAccounts() {
  try {
    let overdue = [];
    try {
      const { rows } = await pool.query(
        `SELECT user_id, username, fee_amount FROM monthly_fees
         WHERE is_overdue = TRUE AND fee_suspended = FALSE`
      );
      overdue = rows;
    } catch (e) {
      console.warn('[fees] suspendOverdueAccounts select error:', e.message);
      return;
    }

    if (!overdue.length) {
      console.log('[fees] No accounts to suspend');
      return;
    }

    for (const fee of overdue) {
      try {
        await pool.query('UPDATE users SET fee_suspended = TRUE WHERE id = $1', [fee.user_id]);
      } catch (e) {
        console.warn('[fees] User suspend exception:', e.message);
      }

      try {
        await pool.query(
          `UPDATE monthly_fees SET fee_suspended = TRUE, suspended_at = NOW(), updated_at = NOW()
           WHERE user_id = $1`,
          [fee.user_id]
        );
      } catch (e) {
        console.warn('[fees] Fee suspend exception:', e.message);
      }

      feeSuspendedUsers.add(fee.user_id);
      console.log(`[fees] Suspended ${fee.username} (unpaid $${fee.fee_amount})`);
    }
  } catch (e) {
    console.warn('[fees] suspendOverdueAccounts error:', e.message);
  }
}

function startFeeScheduler() {
  setTimeout(_loadFeeSuspended, 5000);
  // setInterval disabled temporarily — re-enable once pg query compatibility confirmed
  // setInterval(runDailyFeeCheck, 6 * 60 * 60 * 1000);
  console.log('[fees] Fee scheduler started (periodic checks disabled)');
}

module.exports = { startFeeScheduler, runDailyFeeCheck, suspendOverdueAccounts, feeSuspendedUsers };
