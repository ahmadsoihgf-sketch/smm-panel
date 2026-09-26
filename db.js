/**
 * Database layer with dual-backend support.
 *
 * - If process.env.DATABASE_URL is set -> PostgreSQL via `pg` Pool.
 * - Otherwise -> SQLite file via better-sqlite3 (preferred) or node:sqlite fallback.
 *
 * All application code talks to this module through async helpers using `?`
 * placeholders: db.query(sql, params) -> rows array
 *               db.get(sql, params)   -> single row or null
 *               db.run(sql, params)   -> { changes, lastID }
 *               db.insert(sql, params)-> inserted row id (works on both backends)
 *
 * For pg, `?` placeholders are rewritten to $1, $2, ... automatically.
 * `created_at` values are always set explicitly from JS (ISO strings) so both
 * backends behave identically.
 */

const path = require('path');
const fs = require('fs');

const isPg = !!process.env.DATABASE_URL;

// Translate `?` placeholders to $1, $2, ... for pg.
// (We never use literal '?' inside SQL strings, so a simple scan is safe.)
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// ---------------------------------------------------------------- schema ---
function schemaDdl(pg) {
  const pk = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id ${pk},
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      api_key TEXT UNIQUE,
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id ${pk},
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS providers (
      id ${pk},
      name TEXT NOT NULL,
      api_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      balance_cache REAL,
      last_sync TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS services (
      id ${pk},
      category_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'default',
      rate_per_1000 REAL NOT NULL,
      min INTEGER NOT NULL DEFAULT 100,
      max INTEGER NOT NULL DEFAULT 1000000,
      provider_id INTEGER REFERENCES providers(id),
      provider_service_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id ${pk},
      user_id INTEGER NOT NULL REFERENCES users(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      link TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      charge REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_order_id TEXT,
      start_count INTEGER NOT NULL DEFAULT 0,
      remains INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payment_methods (
      id ${pk},
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'manual',
      account_title TEXT,
      account_number TEXT,
      instructions TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS fund_requests (
      id ${pk},
      user_id INTEGER NOT NULL REFERENCES users(id),
      method_id INTEGER REFERENCES payment_methods(id),
      amount REAL NOT NULL,
      txn_id TEXT,
      receipt_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS balance_logs (
      id ${pk},
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id ${pk},
      user_id INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_messages (
      id ${pk},
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id ${pk},
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_favorites (
      id ${pk},
      user_id INTEGER NOT NULL REFERENCES users(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      created_at TEXT NOT NULL
    )`,
  ];
}

// Indexes are created AFTER migrate() so they never reference not-yet-added columns.
function indexDdl() {
  return [
    `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_service_id ON orders(service_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
    `CREATE INDEX IF NOT EXISTS idx_fund_requests_user_id ON fund_requests(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fund_requests_status ON fund_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_services_category_id ON services(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_services_status ON services(status)`,
    `CREATE INDEX IF NOT EXISTS idx_balance_logs_user_id ON balance_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_favorites_unique ON user_favorites(user_id, service_id)`,
  ];
}

// Add a column if it doesn't exist yet (safe to run on every startup).
// SQLite cannot ADD COLUMN with a UNIQUE constraint, so uniqueness there
// comes from the unique index created in indexDdl().
async function ensureColumn(table, column, pgType, sqliteType) {
  if (isPg) {
    const client = await pgPool.connect();
    try {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${pgType}`);
    } finally {
      client.release();
    }
  } else {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteType || pgType}`);
    }
  }
}

async function migrate() {
  // Referral system columns (added after initial release)
  await ensureColumn('users', 'referral_code', 'TEXT UNIQUE', 'TEXT');
  await ensureColumn('users', 'referred_by', 'INTEGER');
}

// ---------------------------------------------------------------- sqlite ---
let sqliteDb = null;

function openSqlite() {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'panel.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let BetterSqlite3 = null;
  try { BetterSqlite3 = require('better-sqlite3'); } catch (e) { BetterSqlite3 = null; }

  if (BetterSqlite3) {
    sqliteDb = new BetterSqlite3(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb._impl = 'better-sqlite3';
    return;
  }
  // Fallback: node:sqlite (Node 22.5+)
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb._impl = 'node:sqlite';
}

// ------------------------------------------------------------------ pg ----
let pgPool = null;

function openPg() {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pgPool.on('error', (err) => console.error('[pg] pool error:', err.message));
}

// ----------------------------------------------------------------- init ---
let initialized = false;

async function init() {
  if (initialized) return;
  if (isPg) {
    openPg();
    // Fail fast with a clear message if the DB is unreachable.
    const client = await pgPool.connect();
    try {
      for (const ddl of schemaDdl(true)) await client.query(ddl);
      await migrate();
      for (const ddl of indexDdl()) await client.query(ddl);
    } finally {
      client.release();
    }
    console.log('[db] connected to PostgreSQL');
  } else {
    openSqlite();
    for (const ddl of schemaDdl(false)) sqliteDb.exec(ddl);
    await migrate();
    for (const ddl of indexDdl()) sqliteDb.exec(ddl);
    console.log('[db] using SQLite (' + sqliteDb._impl + ')');
  }
  initialized = true;
}

// --------------------------------------------------------------- helpers ---
async function query(sql, params = []) {
  await init();
  if (isPg) {
    const res = await pgPool.query(toPgPlaceholders(sql), params);
    return res.rows;
  }
  return sqliteDb.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  await init();
  if (isPg) {
    const res = await pgPool.query(toPgPlaceholders(sql), params);
    return res.rows[0] || null;
  }
  const row = sqliteDb.prepare(sql).get(...params);
  return row === undefined ? null : row;
}

async function run(sql, params = []) {
  await init();
  if (isPg) {
    const res = await pgPool.query(toPgPlaceholders(sql), params);
    return { changes: res.rowCount || 0, lastID: res.rows && res.rows[0] ? res.rows[0].id : null };
  }
  const info = sqliteDb.prepare(sql).run(...params);
  return { changes: info.changes, lastID: Number(info.lastInsertRowid) };
}

/**
 * Insert a row and get the new id back, portably.
 * The SQL must NOT contain a RETURNING clause; one is appended for pg.
 */
async function insert(sql, params = []) {
  await init();
  if (isPg) {
    const res = await pgPool.query(toPgPlaceholders(sql) + ' RETURNING id', params);
    return res.rows[0].id;
  }
  const info = sqliteDb.prepare(sql).run(...params);
  return Number(info.lastInsertRowid);
}

async function close() {
  if (pgPool) await pgPool.end();
  if (sqliteDb && sqliteDb.close) sqliteDb.close();
}

module.exports = {
  query, get, run, insert, init, close,
  isPostgres: () => isPg,
  // Exported for tests / dry-run validation of the pg code path:
  _toPgPlaceholders: toPgPlaceholders,
  _schemaDdl: schemaDdl,
};
