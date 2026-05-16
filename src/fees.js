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
  const today = new Date();
  const day   = today.getDate();
  const todayStr = today.toISOString().slice(0, 10);

  console.log(`[fees] Daily check — ${todayStr} (day ${day})`);

  // Mark overdue where next_due_date < today (not already paid)
  await supabaseAdmin.from('monthly_fees')
    .update({ is_overdue: true, updated_at: new Date().toISOString() })
    .lt('next_due_date', todayStr)
    .catch(e => console.warn('[fees] Overdue update error:', e.message));

  if (day === 25) await _sendFeeReminders('25th');
  if (day === 1)  await _sendFeeReminders('1st');
  if (day === 5)  await suspendOverdueAccounts();
}

async function _sendFeeReminders(type) {
  let mail;
  try { mail = require('./mail'); } catch { return; }
  const col = type === '25th' ? 'reminder_25_sent_at' : 'reminder_1_sent_at';

  // First of current month — used to deduplicate reminders within a cycle
  const now = new Date();
  const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // Fees where this reminder hasn't been sent this billing cycle
  const { data: fees } = await supabaseAdmin.from('monthly_fees')
    .select('user_id, username, fee_amount, role_type')
    .or(`${col}.is.null,${col}.lt.${cycleStart}`);

  if (!fees?.length) {
    console.log(`[fees] No ${type} reminders to send`);
    return;
  }

  let sent = 0;
  for (const fee of fees) {
    const { data: user } = await supabaseAdmin.from('users')
      .select('email, phone')
      .eq('id', fee.user_id)
      .single();
    if (!user?.email) continue;

    const isUrgent = type === '1st';
    const subject  = isUrgent
      ? `URGENT: $${fee.fee_amount} hosting fee due today — Boston Poker Club`
      : `Reminder: $${fee.fee_amount} hosting fee due in 6 days — Boston Poker Club`;
    const message  = `Boston Poker Club: Your monthly hosting fee of $${fee.fee_amount} is due on the 1st. Pay via CashApp $rabbsroom or Venmo @Roger-Depina`;

    try { await mail.sendFeeReminderEmail({ to: user.email, username: fee.username, amount: fee.fee_amount, subject, message }); } catch {}
    if (user.phone) {
      try { await mail.sendFeeReminderSMS({ phone: user.phone, text: message }); } catch {}
    }

    await supabaseAdmin.from('monthly_fees')
      .update({ [col]: new Date().toISOString() })
      .eq('user_id', fee.user_id)
      .catch(() => {});

    sent++;
  }

  console.log(`[fees] Sent ${type} reminders to ${sent}/${fees.length} hosts/admins`);
}

async function suspendOverdueAccounts() {
  const { data: overdue } = await supabaseAdmin.from('monthly_fees')
    .select('user_id, username, fee_amount')
    .eq('is_overdue', true)
    .eq('fee_suspended', false);

  if (!overdue?.length) {
    console.log('[fees] No accounts to suspend');
    return;
  }

  for (const fee of overdue) {
    await supabaseAdmin.from('users')
      .update({ fee_suspended: true })
      .eq('id', fee.user_id)
      .catch(() => {});

    await supabaseAdmin.from('monthly_fees')
      .update({ fee_suspended: true, suspended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_id', fee.user_id)
      .catch(() => {});

    feeSuspendedUsers.add(fee.user_id);
    console.log(`[fees] Suspended ${fee.username} (unpaid $${fee.fee_amount})`);
  }
}

function startFeeScheduler() {
  _loadFeeSuspended();
  // Check every 6 hours; runDailyFeeCheck is idempotent per calendar day
  setInterval(runDailyFeeCheck, 6 * 60 * 60 * 1000);
  // Initial check ~30 s after startup
  setTimeout(runDailyFeeCheck, 30 * 1000);
  console.log('[fees] Fee scheduler started');
}

module.exports = { startFeeScheduler, runDailyFeeCheck, suspendOverdueAccounts, feeSuspendedUsers };
