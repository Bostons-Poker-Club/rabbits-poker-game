'use strict';

const { supabaseAdmin } = require('./db/supabase');

async function logTransaction({ userId, username, type, amount, tableName, paymentMethod, notes }) {
  try {
    await supabaseAdmin.from('transactions').insert({
      user_id: userId || null,
      username: username || null,
      type,
      amount,
      table_name: tableName || null,
      payment_method: paymentMethod || null,
      notes: notes || null
    });
  } catch (e) {
    console.warn('[tx] log error:', e.message);
  }
}

module.exports = { logTransaction };
