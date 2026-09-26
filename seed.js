/**
 * Seed the database with an admin, a demo user, categories, services,
 * a demo provider, payment methods and default settings.
 * Run: npm run seed
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

async function main(opts = {}) {
  await db.init();
  const now = new Date().toISOString();

  // --- settings ---
  const defaults = {
    site_name: 'BoostPanel',
    currency: 'PKR',
    referral_commission_percent: '5',
    loyalty_tiers: JSON.stringify([
      { min_spent: 5000, discount_pct: 2 },
      { min_spent: 20000, discount_pct: 5 },
      { min_spent: 50000, discount_pct: 10 },
    ]),
    telegram_bot_token: '',
    telegram_chat_id: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    const exists = await db.get('SELECT key FROM settings WHERE key = ?', [k]);
    if (!exists) await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }

  function makeReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async function uniqueReferralCode() {
    for (let i = 0; i < 10; i++) {
      const code = makeReferralCode();
      const exists = await db.get('SELECT id FROM users WHERE referral_code = ?', [code]);
      if (!exists) return code;
    }
    return makeReferralCode() + Date.now().toString(36);
  }

  // Backfill referral codes for users created before the referral feature
  const noCode = await db.query('SELECT id FROM users WHERE referral_code IS NULL');
  for (const u of noCode) {
    await db.run('UPDATE users SET referral_code = ? WHERE id = ?', [await uniqueReferralCode(), u.id]);
  }

  // --- users ---
  async function ensureUser(username, email, password, role) {
    const exists = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (exists) return exists.id;
    const hash = await bcrypt.hash(password, 10);
    const key = require('crypto').randomBytes(24).toString('hex');
    return db.insert(
      `INSERT INTO users (username, email, password_hash, balance, api_key, referral_code, role, status, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?)`,
      [username, email, hash, key, await uniqueReferralCode(), role, now]
    );
  }
  // Admin password: ADMIN_PASSWORD env wins (used on production deploy),
  // otherwise the well-known default for local development.
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  await ensureUser('admin', 'admin@example.com', adminPassword, 'admin');
  await ensureUser('demo', 'demo@example.com', 'demo123', 'user');

  // --- categories ---
  const catNames = ['Instagram', 'TikTok', 'YouTube', 'Facebook'];
  const catIds = {};
  for (let i = 0; i < catNames.length; i++) {
    const name = catNames[i];
    let row = await db.get('SELECT id FROM categories WHERE name = ?', [name]);
    if (!row) {
      const id = await db.insert('INSERT INTO categories (name, position) VALUES (?, ?)', [name, i]);
      catIds[name] = id;
    } else catIds[name] = row.id;
  }

  // --- provider (inactive demo) ---
  let prov = await db.get('SELECT id FROM providers WHERE name = ?', ['Demo Provider']);
  let providerId;
  if (!prov) {
    providerId = await db.insert(
      "INSERT INTO providers (name, api_url, api_key, status) VALUES (?, ?, ?, 'inactive')",
      ['Demo Provider', 'https://provider.example.com/api/v2', 'demo-key']
    );
  } else providerId = prov.id;

  // --- services: [category, name, type, rate_per_1000, min, max, providerLinked] ---
  const seedServices = [
    ['Instagram', 'Instagram Followers | Real | Max 500K | 30 Days Refill', 'default', 450, 100, 500000, true],
    ['Instagram', 'Instagram Likes | Real | Instant Start', 'default', 180, 50, 200000, true],
    ['Instagram', 'Instagram Reels Views | Fast | Lifetime', 'default', 25, 100, 10000000, true],
    ['TikTok', 'TikTok Followers | Real | 30 Days Refill', 'default', 520, 100, 500000, true],
    ['TikTok', 'TikTok Likes | Real | Instant', 'default', 160, 50, 500000, true],
    ['TikTok', 'TikTok Views | Super Fast | Lifetime', 'default', 12, 100, 10000000, true],
    ['YouTube', 'YouTube Subscribers | Real | 30 Days Refill', 'default', 2800, 50, 100000, false],
    ['YouTube', 'YouTube Views | Monetizable | Slow', 'default', 950, 500, 1000000, false],
    ['YouTube', 'YouTube Watch Hours | 4000H Pack', 'package', 9500, 500, 4000, false],
    ['Facebook', 'Facebook Page Likes + Follows | Real', 'default', 700, 100, 200000, false],
    ['Facebook', 'Facebook Post Likes | Instant', 'default', 220, 50, 100000, false],
    ['Facebook', 'Facebook Video Views | Lifetime', 'default', 30, 100, 5000000, false],
  ];
  for (let i = 0; i < seedServices.length; i++) {
    const [cat, name, type, rate, min, max, linked] = seedServices[i];
    const exists = await db.get('SELECT id FROM services WHERE name = ?', [name]);
    if (exists) continue;
    await db.insert(
      `INSERT INTO services (category_id, name, type, rate_per_1000, min, max, provider_id, provider_service_id, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [catIds[cat], name, type, rate, min, max,
       linked ? providerId : null, linked ? String(1000 + i) : null, i]
    );
  }

  // --- payment methods (PLACEHOLDER details - admin must update) ---
  const methods = [
    ['JazzCash', 'manual', 'PLACEHOLDER - Your Name', '0300-0000000',
     '1. Open JazzCash app.\n2. Send money to the account number above.\n3. Copy the Transaction ID (TID) from your receipt.\n4. Submit the form below with the exact amount and TID. Your balance will be credited after verification.'],
    ['EasyPaisa', 'manual', 'PLACEHOLDER - Your Name', '0345-0000000',
     '1. Open EasyPaisa app.\n2. Send money to the account number above.\n3. Copy the Transaction ID (TRX ID) from your receipt.\n4. Submit the form below with the exact amount and TRX ID. Your balance will be credited after verification.'],
  ];
  for (let i = 0; i < methods.length; i++) {
    const [name] = methods[i];
    const exists = await db.get('SELECT id FROM payment_methods WHERE name = ?', [name]);
    if (!exists) {
      await db.insert(
        'INSERT INTO payment_methods (name, type, account_title, account_number, instructions, status, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [...methods[i], 'active', i]
      );
    }
  }

  console.log('Seed complete.');
  if (process.env.ADMIN_PASSWORD) {
    console.log('  admin: admin / (from ADMIN_PASSWORD env)');
  } else {
    console.log('  admin: admin / admin123');
  }
  console.log('  demo : demo / demo123');

  // --- sample announcement ---
  const annCount = await db.get('SELECT COUNT(*) AS c FROM announcements');
  if (annCount.c === 0) {
    await db.insert(
      "INSERT INTO announcements (title, message, status, created_at) VALUES (?, ?, 'active', ?)",
      ['Welcome to BoostPanel 🎉',
       'Top up your balance with JazzCash or EasyPaisa and place your first order in minutes. Need help? Open a support ticket anytime.',
       now]
    );
  }

  if (!opts.keepOpen) await db.close();
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
}
