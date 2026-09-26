const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { getPagination, pageMeta, buildQs } = require('../lib/paginate');
const { getUserTier } = require('../lib/loyalty');
const { notifyAdmin } = require('../lib/telegram');

const router = express.Router();

// Serverless-safe uploads: no persistent disk on hosts like Vercel, so keep
// the file in memory and store it as a data URL in the database. Admin views
// render data: URLs directly, so no view changes are needed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB (under Vercel Hobby's 4.5MB body limit)
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files (PNG, JPG, GIF, WEBP) are allowed.'));
  },
});

// ---------------- Dashboard ----------------
router.get('/dashboard', async (req, res) => {
  const u = res.locals.currentUser;
  const [bal, tot, pend, tick, recent, announcements, referrals, earnings, tier, commission] = await Promise.all([
    db.get('SELECT balance, referral_code FROM users WHERE id = ?', [u.id]),
    db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', [u.id]),
    db.get("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND status IN ('pending','processing','inprogress')", [u.id]),
    db.get("SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status = 'open'", [u.id]),
    db.query(
      `SELECT o.*, s.name AS service_name FROM orders o
       JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 8`, [u.id]
    ),
    db.query("SELECT * FROM announcements WHERE status = 'active' ORDER BY id DESC LIMIT 5"),
    db.get('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?', [u.id]),
    db.get("SELECT COALESCE(SUM(amount), 0) AS total FROM balance_logs WHERE user_id = ? AND reason LIKE 'Referral commission%'", [u.id]),
    getUserTier(u.id),
    db.get("SELECT value FROM settings WHERE key = 'referral_commission_percent'"),
  ]);
  res.render('user/dashboard', {
    title: 'Dashboard',
    stats: { balance: bal.balance, totalOrders: tot.c, pendingOrders: pend.c, openTickets: tick.c },
    recent, announcements,
    referral: {
      code: bal.referral_code,
      link: req.protocol + '://' + req.get('host') + '/register?ref=' + bal.referral_code,
      signups: referrals.c,
      earnings: earnings.total,
      commissionPct: commission ? Number(commission.value) || 0 : 0,
    },
    loyalty: tier,
  });
});

// ---------------- New order ----------------
router.get('/order/new', async (req, res) => {
  const u = res.locals.currentUser;
  const categories = await db.query(
    `SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id AND s.status='active') AS service_count
     FROM categories c ORDER BY c.position, c.id`
  );
  const services = await db.query(
    `SELECT s.*, c.name AS category_name FROM services s
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.status = 'active' ORDER BY c.position, c.id, s.position, s.id`
  );
  const favRows = await db.query('SELECT service_id FROM user_favorites WHERE user_id = ?', [u.id]);
  const favorites = new Set(favRows.map((r) => r.service_id));
  const tier = await getUserTier(u.id);
  res.render('user/order_new', {
    title: 'New order', categories, services,
    favoriteIds: [...favorites], discountPct: tier.discount_pct,
  });
});

router.post('/order/new', async (req, res) => {
  const u = res.locals.currentUser;
  const serviceId = parseInt(req.body.service_id, 10);
  const link = (req.body.link || '').trim();
  const quantity = parseInt(req.body.quantity, 10);

  const service = await db.get('SELECT * FROM services WHERE id = ? AND status = ?', [serviceId, 'active']);
  if (!service) { req.flash('error', 'Invalid service selected.'); return res.redirect('/order/new'); }
  if (!link || !/^https?:\/\/.+\..+/.test(link)) {
    req.flash('error', 'Please enter a valid link (starting with http:// or https://).');
    return res.redirect('/order/new');
  }
  if (!Number.isInteger(quantity) || quantity < service.min || quantity > service.max) {
    req.flash('error', `Quantity must be between ${service.min.toLocaleString()} and ${service.max.toLocaleString()}.`);
    return res.redirect('/order/new');
  }
  const tier = await getUserTier(u.id);
  const discountPct = tier.discount_pct;
  const effectiveRate = service.rate_per_1000 * (1 - discountPct / 100);
  const charge = Math.round((effectiveRate * quantity / 1000) * 100) / 100;
  const me = await db.get('SELECT balance FROM users WHERE id = ?', [u.id]);
  if (me.balance < charge) {
    req.flash('error', `Insufficient balance. This order costs ${charge.toFixed(2)} but you have ${Number(me.balance).toFixed(2)}.`);
    return res.redirect('/order/new');
  }

  const now = new Date().toISOString();
  await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [charge, u.id]);
  await db.run(
    `INSERT INTO balance_logs (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)`,
    [u.id, -charge, 'Order placed', now]
  );
  const orderId = await db.insert(
    `INSERT INTO orders (user_id, service_id, link, quantity, charge, status, start_count, remains, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [u.id, service.id, link, quantity, charge, quantity, now]
  );
  notifyAdmin(`🧾 <b>New order</b> #${orderId}\nUser: ${u.username}\nService: ${service.name.slice(0, 60)}\nQty: ${quantity.toLocaleString()} | Charge: ${charge.toFixed(2)}`);
  req.flash('success', `Order #${orderId} placed successfully!`);
  res.redirect('/orders');
});

// ---------------- Favorites ----------------
router.post('/favorites/toggle', async (req, res) => {
  const u = res.locals.currentUser;
  const serviceId = parseInt(req.body.service_id, 10);
  const service = await db.get('SELECT id FROM services WHERE id = ? AND status = ?', [serviceId, 'active']);
  if (!service) return res.json({ ok: false });
  const existing = await db.get('SELECT id FROM user_favorites WHERE user_id = ? AND service_id = ?', [u.id, serviceId]);
  if (existing) {
    await db.run('DELETE FROM user_favorites WHERE id = ?', [existing.id]);
    return res.json({ ok: true, favorited: false });
  }
  await db.insert('INSERT INTO user_favorites (user_id, service_id, created_at) VALUES (?, ?, ?)',
    [u.id, serviceId, new Date().toISOString()]);
  return res.json({ ok: true, favorited: true });
});

// ---------------- Orders (paginated, 50/page) ----------------
router.get('/orders', async (req, res) => {
  const u = res.locals.currentUser;
  const status = (req.query.status || '').trim();
  const allowed = ['pending', 'processing', 'inprogress', 'completed', 'partial', 'canceled'];
  const hasStatus = allowed.includes(status);
  const { page, perPage } = getPagination(req);

  const where = hasStatus ? ' AND o.status = ?' : '';
  const countParams = hasStatus ? [u.id, status] : [u.id];
  const totalRow = await db.get(
    `SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = ?${where}`, countParams
  );
  const pg = pageMeta(totalRow.c, page, perPage);

  const orders = await db.query(
    `SELECT o.*, s.name AS service_name FROM orders o
     JOIN services s ON s.id = o.service_id
     WHERE o.user_id = ?${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...countParams, perPage, pg.offset]
  );
  res.render('user/orders', {
    title: 'My orders', orders, statusFilter: status,
    page: pg.page, pages: pg.pages, total: pg.total, qs: buildQs(req.query),
  });
});

// ---------------- Funds: add ----------------
router.get('/funds/add', async (req, res) => {
  const methods = await db.query(
    "SELECT * FROM payment_methods WHERE status = 'active' ORDER BY position, id"
  );
  res.render('user/funds_add', { title: 'Add funds', methods });
});

router.post('/funds/add', upload.single('receipt'), async (req, res) => {
  const u = res.locals.currentUser;
  try {
    const methodId = parseInt(req.body.method_id, 10);
    const amount = parseFloat(req.body.amount);
    const txnId = (req.body.txn_id || '').trim();

    const method = await db.get("SELECT * FROM payment_methods WHERE id = ? AND status = 'active'", [methodId]);
    if (!method) { req.flash('error', 'Please select a valid payment method.'); return res.redirect('/funds/add'); }
    if (!Number.isFinite(amount) || amount < 50) {
      req.flash('error', 'Minimum deposit amount is 50.');
      return res.redirect('/funds/add');
    }
    if (!txnId) { req.flash('error', 'Transaction ID is required.'); return res.redirect('/funds/add'); }

    const receiptPath = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
      : null;
    const now = new Date().toISOString();
    const frId = await db.insert(
      `INSERT INTO fund_requests (user_id, method_id, amount, txn_id, receipt_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [u.id, method.id, amount, txnId, receiptPath, now]
    );
    notifyAdmin(`💰 <b>New fund request</b> #${frId}\nUser: ${u.username}\nMethod: ${method.name}\nAmount: ${amount.toFixed(2)}\nTxn: ${txnId}`);
    req.flash('success', 'Fund request submitted. It will be credited after admin approval.');
    res.redirect('/funds/history');
  } catch (e) {
    req.flash('error', e.message || 'Upload failed.');
    res.redirect('/funds/add');
  }
});

// ---------------- Funds: history ----------------
router.get('/funds/history', async (req, res) => {
  const u = res.locals.currentUser;
  const requests = await db.query(
    `SELECT f.*, m.name AS method_name FROM fund_requests f
     LEFT JOIN payment_methods m ON m.id = f.method_id
     WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 100`, [u.id]
  );
  res.render('user/funds_history', { title: 'Fund history', requests });
});

// ---------------- Tickets ----------------
router.get('/tickets', async (req, res) => {
  const u = res.locals.currentUser;
  const tickets = await db.query(
    `SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS msg_count
     FROM tickets t WHERE t.user_id = ? ORDER BY t.id DESC`, [u.id]
  );
  res.render('user/tickets', { title: 'Support tickets', tickets });
});

router.post('/tickets', async (req, res) => {
  const u = res.locals.currentUser;
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  if (subject.length < 4 || message.length < 4) {
    req.flash('error', 'Subject and message are required.');
    return res.redirect('/tickets');
  }
  const now = new Date().toISOString();
  const ticketId = await db.insert(
    'INSERT INTO tickets (user_id, subject, status, created_at) VALUES (?, ?, ?, ?)',
    [u.id, subject.slice(0, 120), 'open', now]
  );
  await db.insert(
    'INSERT INTO ticket_messages (ticket_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [ticketId, u.id, message, now]
  );
  req.flash('success', 'Ticket created.');
  res.redirect('/tickets/' + ticketId);
});

router.get('/tickets/:id', async (req, res) => {
  const u = res.locals.currentUser;
  const ticket = await db.get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', [req.params.id, u.id]);
  if (!ticket) { req.flash('error', 'Ticket not found.'); return res.redirect('/tickets'); }
  const messages = await db.query(
    `SELECT m.*, us.username FROM ticket_messages m
     JOIN users us ON us.id = m.user_id
     WHERE m.ticket_id = ? ORDER BY m.id ASC`, [ticket.id]
  );
  res.render('user/ticket_view', { title: 'Ticket #' + ticket.id, ticket, messages });
});

router.post('/tickets/:id', async (req, res) => {
  const u = res.locals.currentUser;
  const ticket = await db.get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', [req.params.id, u.id]);
  if (!ticket) { req.flash('error', 'Ticket not found.'); return res.redirect('/tickets'); }
  const message = (req.body.message || '').trim();
  if (message.length < 2) { req.flash('error', 'Message is empty.'); return res.redirect('/tickets/' + ticket.id); }
  const now = new Date().toISOString();
  await db.insert(
    'INSERT INTO ticket_messages (ticket_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [ticket.id, u.id, message, now]
  );
  if (ticket.status === 'closed') await db.run("UPDATE tickets SET status = 'open' WHERE id = ?", [ticket.id]);
  res.redirect('/tickets/' + ticket.id);
});

// ---------------- API docs ----------------
router.get('/api', async (req, res) => {
  res.render('user/api_docs', { title: 'API', baseUrl: req.protocol + '://' + req.get('host') });
});

router.post('/api/regenerate', async (req, res) => {
  const u = res.locals.currentUser;
  const key = crypto.randomBytes(24).toString('hex');
  await db.run('UPDATE users SET api_key = ? WHERE id = ?', [key, u.id]);
  req.flash('success', 'API key regenerated. Update your scripts!');
  res.redirect('/api');
});

// ---------------- Change password ----------------
router.get('/account/password', async (req, res) => {
  res.render('user/password', { title: 'Change password' });
});

router.post('/account/password', async (req, res) => {
  const u = res.locals.currentUser;
  const current = req.body.current_password || '';
  const next = req.body.new_password || '';
  const confirm = req.body.confirm_password || '';
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  if (!row || !(await bcrypt.compare(current, row.password_hash))) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect('/account/password');
  }
  if (next.length < 6) {
    req.flash('error', 'New password must be at least 6 characters.');
    return res.redirect('/account/password');
  }
  if (next !== confirm) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect('/account/password');
  }
  const hash = await bcrypt.hash(next, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, u.id]);
  req.flash('success', 'Password changed successfully.');
  res.redirect('/account/password');
});

module.exports = router;
