'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const username = process.argv[2] || 'admin';
const password = process.argv[3] || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

async function main() {
  const hash = await bcrypt.hash(password, 10);

  console.log('\n✅ Admin credentials ready (local bypass — no Supabase needed)');
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Username      : ${username}`);
  console.log(`  Password      : ${password}`);
  console.log(`  Password hash : ${hash}`);

  const token = jwt.sign(
    { id: 'local-admin-000', username, isAdmin: true },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`\n  JWT Token (7 days):\n  ${token}`);
  console.log('\n─────────────────────────────────────────────────────');
  console.log('To use: go to http://localhost:3000 and log in with the credentials above.');
  console.log('Or paste this in browser console to skip login:');
  console.log(`  localStorage.setItem('rp_token', '${token}')`);
  console.log(`  localStorage.setItem('rp_user', JSON.stringify({id:'local-admin-000',username:'${username}',email:'admin@rabbitspoker.com',chips:999999,isAdmin:true}))`);
  console.log(`  window.location.href = '/lobby.html'`);

  if (hash !== '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy') {
    console.log(`\nTo make this hash permanent, add to .env:`);
    console.log(`  ADMIN_PASSWORD_HASH=${hash}`);
  }
}

main();
