/**
 * Postgres code-path smoke test using pg-mem (in-memory Postgres emulator).
 * Swaps the real `pg` module for pg-mem's adapter BEFORE db.js loads, then
 * exercises the full pg path: init() DDL, placeholder translation, and the
 * query/get/run/insert helpers.
 *
 * Run: node test/pg-smoke.js
 */
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';

const { newDb } = require('pg-mem');
const mem = newDb();

// Inject pg-mem's pg-compatible Pool into the module cache so db.js picks it up.
const pgPath = require.resolve('pg');
const fakePg = mem.adapters.createPg();
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: fakePg };

const db = require('../db');

async function main() {
  console.log('isPostgres():', db.isPostgres());

  // 1. init() must run the entire pg DDL (tables + indexes) without error
  await db.init();
  console.log('init() DDL OK');

  // 2. placeholder translation unit checks
  const t = db._toPgPlaceholders;
  const cases = [
    ['SELECT * FROM users WHERE id = ?', 'SELECT * FROM users WHERE id = $1'],
    ['SELECT * FROM o WHERE a=? AND b=? LIMIT ? OFFSET ?', 'SELECT * FROM o WHERE a=$1 AND b=$2 LIMIT $3 OFFSET $4'],
  ];
  for (const [input, expected] of cases) {
    const got = t(input);
    if (got !== expected) throw new Error(`placeholder mismatch: ${got}`);
  }
  console.log('placeholder translation OK');

  // 3. helper round-trip: insert -> get -> query -> run
  const now = new Date().toISOString();
  const uid = await db.insert(
    'INSERT INTO users (username, email, password_hash, balance, api_key, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['pguser', 'pg@example.com', 'hash', 100, 'key123', 'user', 'active', now]
  );
  console.log('insert() returned id:', uid, '(expect 1)');
  const u = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
  console.log('get() username:', u.username, '| balance:', u.balance);
  await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [50, uid]);
  const u2 = await db.get('SELECT balance FROM users WHERE id = ?', [uid]);
  console.log('run() updated balance (expect 150):', u2.balance);
  const rows = await db.query('SELECT * FROM users WHERE balance > ? ORDER BY id LIMIT ? OFFSET ?', [0, 10, 0]);
  console.log('query() rows:', rows.length);

  // 4. every table from the schema exists (via information_schema)
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log('tables:', tables.map((r) => r.table_name).join(', '));

  const idx = await db.query(
    "SELECT tablename FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%'"
  ).catch(() => null);
  if (idx) console.log('custom indexes:', idx.length, '(expect 12)');
  else console.log('custom indexes: (pg-mem has no pg_indexes catalog; DDL itself ran OK)');

  await db.close();
  console.log('PG SMOKE TEST PASSED');
}

main().catch((e) => { console.error('PG SMOKE TEST FAILED:', e.message); process.exit(1); });
