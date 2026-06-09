'use strict';

const pool = require('./db');

async function logTransaction({ userId, username, type, amount, tableName, paymentMethod, notes }) {
  try {
    await pool.query(
      `INSERT INTO transactions (user_id, username, type, amount, table_name, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId || null, username || null, type, amount, tableName || null, paymentMethod || null, notes || null]
    );
  } catch (e) {
    console.warn('[tx] log error:', e.message);
  }
}

module.exports = { logTransaction };
