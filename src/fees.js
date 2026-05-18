'use strict';
const { supabaseAdmin } = require('./db/supabase');

// In-memory set of fee-suspended user IDs for fast auth checks
const feeSuspendedUsers = new Set();

async function _loadFeeSuspended() {
  try {
    const { data } = await supabaseAdmin.from('users').select('id').eq('fee_suspended', true);
    feeSuspendedUsers.clear();
    if (data) data.forEach(u => feeSuspendedUsers.add(u.id));
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

    // Mark overdue where next_due_date is before today
    try {
      const result = await supabaseAdmin
        .from('monthly_fees')
        .update({ is_overdue: true, updated_at: new Date().toISOString() })
        .lt('next_due_date', todayStr);
      if (result.error) console.warn('[fees] Overdue update error:', result.error.message);
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
      const result = await supabaseAdmin
        .from('monthly_fees')
        .select('user_id, username, fee_amount, role_type')
        .or(`${col}.is.null,${col}.lt.${cycleStart}`);
      fees = result.data || [];
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
          const result = await supabaseAdmin
            .from('users')
            .select('email, phone')
            .eq('id', fee.user_id)
            .single();
          user = result.data;
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
          const result = await supabaseAdmin
            .from('monthly_fees')
            .update({ [col]: new Date().toISOString() })
            .eq('user_id', fee.user_id);
          if (result.error) console.warn('[fees] Reminder timestamp update error:', result.error.message);
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
      const result = await supabaseAdmin
        .from('monthly_fees')
        .select('user_id, username, fee_amount')
        .eq('is_overdue', true)
        .eq('fee_suspended', false);
      overdue = result.data || [];
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
        const r1 = await supabaseAdmin
          .from('users')
          .update({ fee_suspended: true })
          .eq('id', fee.user_id);
        if (r1.error) console.warn('[fees] User suspend error:', r1.error.message);
      } catch (e) {
        console.warn('[fees] User suspend exception:', e.message);
      }

      try {
        const r2 = await supabaseAdmin
          .from('monthly_fees')
          .update({ fee_suspended: true, suspended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('user_id', fee.user_id);
        if (r2.error) console.warn('[fees] Fee suspend error:', r2.error.message);
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
  // Defer DB call so it doesn't compete with server startup / health check
  setTimeout(_loadFeeSuspended, 5000);
  // setInterval disabled temporarily — re-enable once Supabase query compatibility confirmed
  // setInterval(runDailyFeeCheck, 6 * 60 * 60 * 1000);
  // setTimeout(runDailyFeeCheck, 30 * 1000);
  console.log('[fees] Fee scheduler started (periodic checks disabled)');
}

module.exports = { startFeeScheduler, runDailyFeeCheck, suspendOverdueAccounts, feeSuspendedUsers };
