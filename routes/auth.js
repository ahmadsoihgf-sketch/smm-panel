const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function randomApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

// Landing page
router.get('/', async (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  const services = await db.query(
    `SELECT s.id, s.name, s.rate_per_1000, s.min, s.max, c.name AS category
     FROM services s LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.status = 'active' ORDER BY c.position, c.id, s.position, s.id LIMIT 100`
  ).catch(() => []);
  const stats = await db.get(
    `SELECT (SELECT COUNT(*) FROM orders) AS orders,
            (SELECT COUNT(*) FROM users WHERE role='user') AS users,
            (SELECT COUNT(*) FROM services WHERE status='active') AS services`
  ).catch(() => ({ orders: 0, users: 0, services: 0 }));
  res.render('landing', { title: 'Home', services, stats });
});

// Login
router.get('/login', (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('login', { title: 'Log in' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.get(
    'SELECT * FROM users WHERE username = ? OR email = ?',
    [username || '', username || '']
  );
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/login');
  }
  if (user.status !== 'active') {
    req.flash('error', 'Your account has been disabled. Contact support.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.flash('success', 'Welcome back, ' + user.username + '!');
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
});

// Register
router.get('/register', async (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  const refCode = (req.query.ref || '').trim().toUpperCase();
  let referrer = null;
  if (refCode) referrer = await db.get('SELECT username FROM users WHERE referral_code = ?', [refCode]);
  res.render('register', { title: 'Create account', refCode: referrer ? refCode : '', referrer });
});

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

router.post('/register', async (req, res) => {
  const { username, email, password, password2 } = req.body;
  const u = (username || '').trim();
  const e = (email || '').trim().toLowerCase();

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) {
    req.flash('error', 'Username must be 3-30 characters (letters, numbers, underscore).');
    return res.redirect('/register');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
    req.flash('error', 'Please enter a valid email address.');
    return res.redirect('/register');
  }
  if (!password || password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters.');
    return res.redirect('/register');
  }
  if (password !== password2) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/register');
  }
  const exists = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [u, e]);
  if (exists) {
    req.flash('error', 'Username or email is already taken.');
    return res.redirect('/register');
  }
  const hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  // Referral: optional ?ref=CODE
  let referredBy = null;
  const refCode = (req.body.ref || '').trim().toUpperCase();
  if (refCode) {
    const referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', [refCode]);
    if (referrer) referredBy = referrer.id;
  }
  const id = await db.insert(
    `INSERT INTO users (username, email, password_hash, balance, api_key, referral_code, referred_by, role, status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'user', 'active', ?)`,
    [u, e, hash, randomApiKey(), await uniqueReferralCode(), referredBy, now]
  );
  req.session.userId = id;
  req.flash('success', 'Account created! Welcome to the panel.');
  res.redirect('/dashboard');
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
