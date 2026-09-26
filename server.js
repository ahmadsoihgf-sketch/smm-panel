/**
 * SMM Panel - main entry point.
 * Run: npm start (after `npm run seed` on first run)
 */

try { require('dotenv').config(); } catch (e) { /* dotenv is optional */ }

const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Persistent session store on Postgres (free hosting restarts wipe memory sessions)
let sessionStore;
if (process.env.DATABASE_URL) {
  try {
    const PgSession = require('connect-pg-simple')(session);
    sessionStore = new PgSession({ conString: process.env.DATABASE_URL, createTableIfMissing: true });
    console.log('Sessions: PostgreSQL store');
  } catch (e) { console.log('Sessions: memory store (pg session store unavailable)'); }
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
}));

// Flash messages (simple, no extra dependency)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

// Current user + settings available in all views
app.use(async (req, res, next) => {
  res.locals.currentUser = null;
  if (req.session.userId) {
    try {
      const u = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
      if (u && u.status === 'active') res.locals.currentUser = u;
      else delete req.session.userId;
    } catch (e) { /* db not ready yet */ }
  }
  try {
    const rows = await db.query('SELECT key, value FROM settings');
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    res.locals.settings = Object.assign({ site_name: 'SMM Panel', currency: 'PKR' }, s);
  } catch (e) {
    res.locals.settings = { site_name: 'SMM Panel', currency: 'PKR' };
  }
  next();
});

// Auth guards
function requireLogin(req, res, next) {
  if (!res.locals.currentUser) { req.flash('error', 'Please log in first.'); return res.redirect('/login'); }
  next();
}
function requireAdmin(req, res, next) {
  if (!res.locals.currentUser) { req.flash('error', 'Please log in first.'); return res.redirect('/login'); }
  if (res.locals.currentUser.role !== 'admin') { req.flash('error', 'Admin access required.'); return res.redirect('/dashboard'); }
  next();
}
app.locals.requireLogin = requireLogin;
app.locals.requireAdmin = requireAdmin;

// View helpers
app.locals.money = (n) => Number(n || 0).toFixed(2);
app.locals.dt = (s) => {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
app.locals.statusBadge = (s) => {
  const map = {
    pending: 'bg-amber-100 text-amber-800', processing: 'bg-blue-100 text-blue-800',
    inprogress: 'bg-blue-100 text-blue-800', completed: 'bg-green-100 text-green-800',
    partial: 'bg-orange-100 text-orange-800', canceled: 'bg-red-100 text-red-800',
    open: 'bg-blue-100 text-blue-800', closed: 'bg-slate-200 text-slate-700',
    approved: 'bg-green-100 text-green-800', rejected: 'bg-red-100 text-red-800',
    active: 'bg-green-100 text-green-800', inactive: 'bg-slate-200 text-slate-700',
    disabled: 'bg-red-100 text-red-800',
  };
  const cls = map[String(s).toLowerCase()] || 'bg-slate-200 text-slate-700';
  return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}">${s}</span>`;
};

// Routes
app.use('/', require('./routes/auth'));
app.use('/api/v2', require('./routes/apiv2'));
app.use('/', requireLogin, require('./routes/user'));
app.use('/admin', requireAdmin, require('./routes/admin'));

// 404
app.use((req, res) => res.status(404).render('404', { title: 'Not found' }));

// Start
db.init().then(async () => {
  // First boot on a fresh database (e.g. production deploy): seed automatically
  try {
    const c = await db.get('SELECT COUNT(*) AS c FROM users');
    if (c && Number(c.c) === 0) {
      console.log('Empty database detected — running seed...');
      await require('./seed')({ keepOpen: true });
    }
  } catch (e) { console.log('Auto-seed skipped:', e.message); }
  app.listen(PORT, () => {
    console.log(`SMM Panel running on http://localhost:${PORT}`);
    console.log('Backend:', db.isPostgres() ? 'PostgreSQL' : 'SQLite');
  });
}).catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

module.exports = app;
