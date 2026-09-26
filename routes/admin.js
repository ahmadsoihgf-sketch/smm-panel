const express = require('express');
const db = require('../db');
const { callProvider, fetchProviderServices, fetchProviderBalance } = require('../lib/provider');
const { getPagination, pageMeta, buildQs } = require('../lib/paginate');
const { sendMessage, clearCache } = require('../lib/telegram');

const router = express.Router();

// ---------------- Dashboard ----------------
router.get('/', async (req, res) => {
  const stats = await db.get(`
    SELECT (SELECT COUNT(*) FROM users WHERE role='user') AS users,
           (SELECT COUNT(*) FROM orders) AS orders,
           (SELECT COALESCE(SUM(charge),0) FROM orders) AS revenue,
           (SELECT COUNT(*) FROM fund_requests WHERE status='pending') AS pending_funds,
           (SELECT COUNT(*) FROM tickets WHERE status='open') AS open_tickets,
           (SELECT COUNT(*) FROM orders WHERE status='pending') AS pending_orders
  `);
  const recentOrders = await db.query(
    `SELECT o.*, s.name AS service_name, u.username FROM orders o
     JOIN services s ON s.id = o.service_id JOIN users u ON u.id = o.user_id
     ORDER BY o.id DESC LIMIT 10`
  );
  res.render('admin/dashboard', { title: 'Admin dashboard', stats, recentOrders });
});

// ---------------- Services ----------------
router.get('/services', async (req, res) => {
  const services = await db.query(
    `SELECT s.*, c.name AS category_name, p.name AS provider_name FROM services s
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN providers p ON p.id = s.provider_id
     ORDER BY c.position, c.id, s.position, s.id`
  );
  const categories = await db.query('SELECT * FROM categories ORDER BY position, id');
  const providers = await db.query('SELECT * FROM providers ORDER BY id');
  res.render('admin/services', { title: 'Services', services, categories, providers });
});

router.post('/services', async (req, res) => {
  const b = req.body;
  const providerId = b.provider_id ? parseInt(b.provider_id, 10) : null;
  await db.insert(
    `INSERT INTO services (category_id, name, type, rate_per_1000, min, max, provider_id, provider_service_id, status, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.category_id ? parseInt(b.category_id, 10) : null,
      (b.name || '').trim(), (b.type || 'default').trim(),
      parseFloat(b.rate_per_1000) || 0, parseInt(b.min, 10) || 0, parseInt(b.max, 10) || 0,
      providerId, (b.provider_service_id || '').trim() || null,
      b.status === 'inactive' ? 'inactive' : 'active', parseInt(b.position, 10) || 0,
    ]
  );
  req.flash('success', 'Service added.');
  res.redirect('/admin/services');
});

router.post('/services/:id', async (req, res) => {
  const b = req.body;
  const providerId = b.provider_id ? parseInt(b.provider_id, 10) : null;
  await db.run(
    `UPDATE services SET category_id=?, name=?, type=?, rate_per_1000=?, min=?, max=?,
     provider_id=?, provider_service_id=?, status=?, position=? WHERE id=?`,
    [
      b.category_id ? parseInt(b.category_id, 10) : null,
      (b.name || '').trim(), (b.type || 'default').trim(),
      parseFloat(b.rate_per_1000) || 0, parseInt(b.min, 10) || 0, parseInt(b.max, 10) || 0,
      providerId, (b.provider_service_id || '').trim() || null,
      b.status === 'inactive' ? 'inactive' : 'active', parseInt(b.position, 10) || 0,
      req.params.id,
    ]
  );
  req.flash('success', 'Service updated.');
  res.redirect('/admin/services');
});

router.post('/services/:id/delete', async (req, res) => {
  const used = await db.get('SELECT COUNT(*) AS c FROM orders WHERE service_id = ?', [req.params.id]);
  if (used.c > 0) {
    await db.run("UPDATE services SET status='inactive' WHERE id=?", [req.params.id]);
    req.flash('success', 'Service has orders, so it was deactivated instead of deleted.');
  } else {
    await db.run('DELETE FROM services WHERE id=?', [req.params.id]);
    req.flash('success', 'Service deleted.');
  }
  res.redirect('/admin/services');
});

// ---------------- Categories ----------------
router.get('/categories', async (req, res) => {
  const categories = await db.query(
    `SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id) AS service_count
     FROM categories c ORDER BY c.position, c.id`
  );
  res.render('admin/categories', { title: 'Categories', categories });
});

router.post('/categories', async (req, res) => {
  await db.insert('INSERT INTO categories (name, position) VALUES (?, ?)',
    [(req.body.name || '').trim(), parseInt(req.body.position, 10) || 0]);
  req.flash('success', 'Category added.');
  res.redirect('/admin/categories');
});

router.post('/categories/:id', async (req, res) => {
  await db.run('UPDATE categories SET name=?, position=? WHERE id=?',
    [(req.body.name || '').trim(), parseInt(req.body.position, 10) || 0, req.params.id]);
  req.flash('success', 'Category updated.');
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', async (req, res) => {
  const used = await db.get('SELECT COUNT(*) AS c FROM services WHERE category_id = ?', [req.params.id]);
  if (used.c > 0) { req.flash('error', 'Cannot delete: services exist in this category.'); }
  else { await db.run('DELETE FROM categories WHERE id=?', [req.params.id]); req.flash('success', 'Category deleted.'); }
  res.redirect('/admin/categories');
});

// ---------------- Providers ----------------
router.get('/providers', async (req, res) => {
  const providers = await db.query('SELECT * FROM providers ORDER BY id');
  res.render('admin/providers', { title: 'API Providers', providers });
});

router.post('/providers', async (req, res) => {
  await db.insert(
    'INSERT INTO providers (name, api_url, api_key, status) VALUES (?, ?, ?, ?)',
    [(req.body.name || '').trim(), (req.body.api_url || '').trim(), (req.body.api_key || '').trim(),
     req.body.status === 'inactive' ? 'inactive' : 'active']
  );
  req.flash('success', 'Provider added.');
  res.redirect('/admin/providers');
});

router.post('/providers/:id', async (req, res) => {
  await db.run('UPDATE providers SET name=?, api_url=?, api_key=?, status=? WHERE id=?',
    [(req.body.name || '').trim(), (req.body.api_url || '').trim(), (req.body.api_key || '').trim(),
     req.body.status === 'inactive' ? 'inactive' : 'active', req.params.id]);
  req.flash('success', 'Provider updated.');
  res.redirect('/admin/providers');
});

router.post('/providers/:id/delete', async (req, res) => {
  const used = await db.get('SELECT COUNT(*) AS c FROM services WHERE provider_id = ?', [req.params.id]);
  if (used.c > 0) { req.flash('error', 'Cannot delete: services are linked to this provider.'); }
  else { await db.run('DELETE FROM providers WHERE id=?', [req.params.id]); req.flash('success', 'Provider deleted.'); }
  res.redirect('/admin/providers');
});

router.post('/providers/:id/balance', async (req, res) => {
  const provider = await db.get('SELECT * FROM providers WHERE id = ?', [req.params.id]);
  try {
    const balance = await fetchProviderBalance(provider);
    await db.run('UPDATE providers SET balance_cache=?, last_sync=? WHERE id=?',
      [balance, new Date().toISOString(), provider.id]);
    req.flash('success', `Provider balance: ${balance}`);
  } catch (e) {
    req.flash('error', 'Balance check failed: ' + e.message);
  }
  res.redirect('/admin/providers');
});

// Sync services from provider -> show import screen
router.get('/providers/:id/sync', async (req, res) => {
  const provider = await db.get('SELECT * FROM providers WHERE id = ?', [req.params.id]);
  if (!provider) { req.flash('error', 'Provider not found.'); return res.redirect('/admin/providers'); }
  try {
    const services = await fetchProviderServices(provider);
    await db.run('UPDATE providers SET last_sync=? WHERE id=?', [new Date().toISOString(), provider.id]);
    const existing = await db.query(
      'SELECT provider_service_id FROM services WHERE provider_id = ?', [provider.id]
    );
    const existingIds = new Set(existing.map((e) => e.provider_service_id));
    const categories = await db.query('SELECT * FROM categories ORDER BY position, id');
    res.render('admin/provider_sync', {
      title: 'Sync services', provider, services, existingIds, categories,
    });
  } catch (e) {
    req.flash('error', 'Sync failed: ' + e.message);
    res.redirect('/admin/providers');
  }
});

// Import selected provider services as local services
router.post('/providers/:id/sync', async (req, res) => {
  const provider = await db.get('SELECT * FROM providers WHERE id = ?', [req.params.id]);
  if (!provider) { req.flash('error', 'Provider not found.'); return res.redirect('/admin/providers'); }
  let items = req.body.items;
  if (!items) { req.flash('error', 'No services selected.'); return res.redirect('/admin/providers/' + provider.id + '/sync'); }
  if (!Array.isArray(items)) items = [items];
  // items arrive as JSON strings from the form
  let count = 0, skipped = 0;
  for (const raw of items) {
    let it;
    try { it = JSON.parse(raw); } catch (e) { continue; }
    if (!it.provider_service_id) continue;
    const exists = await db.get(
      'SELECT id FROM services WHERE provider_id = ? AND provider_service_id = ?',
      [provider.id, it.provider_service_id]
    );
    if (exists) { skipped++; continue; }
    const markup = parseFloat(req.body.markup || '0') || 0;
    const rate = Math.round((Number(it.rate) * (1 + markup / 100)) * 10000) / 10000;
    await db.insert(
      `INSERT INTO services (category_id, name, type, rate_per_1000, min, max, provider_id, provider_service_id, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      [
        req.body.category_id ? parseInt(req.body.category_id, 10) : null,
        String(it.name).slice(0, 200), String(it.type || 'default').slice(0, 50),
        rate, Number(it.min) || 0, Number(it.max) || 0,
        provider.id, String(it.provider_service_id),
      ]
    );
    count++;
  }
  req.flash('success', `Imported ${count} service(s)` + (skipped ? `, skipped ${skipped} already-imported.` : '.'));
  res.redirect('/admin/services');
});

// ---------------- Orders (paginated, 50/page) ----------------
router.get('/orders', async (req, res) => {
  const status = (req.query.status || '').trim();
  const q = (req.query.q || '').trim();
  const { page, perPage } = getPagination(req);

  let where = ' WHERE 1=1';
  const params = [];
  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (q) { where += ' AND (o.id = ? OR o.link LIKE ? OR u.username LIKE ?)'; params.push(parseInt(q, 10) || -1, `%${q}%`, `%${q}%`); }

  const totalRow = await db.get(
    `SELECT COUNT(*) AS c FROM orders o
     JOIN services s ON s.id = o.service_id JOIN users u ON u.id = o.user_id${where}`, params
  );
  const pg = pageMeta(totalRow.c, page, perPage);

  const orders = await db.query(
    `SELECT o.*, s.name AS service_name, u.username, p.name AS provider_name FROM orders o
     JOIN services s ON s.id = o.service_id JOIN users u ON u.id = o.user_id
     LEFT JOIN providers p ON p.id = s.provider_id${where}
     ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, pg.offset]
  );
  res.render('admin/orders', {
    title: 'Orders', orders, statusFilter: status, q,
    page: pg.page, pages: pg.pages, total: pg.total, qs: buildQs(req.query),
  });
});

router.post('/orders/:id/status', async (req, res) => {
  const allowed = ['pending', 'processing', 'inprogress', 'completed', 'partial', 'canceled'];
  const status = req.body.status;
  if (!allowed.includes(status)) { req.flash('error', 'Invalid status.'); return res.redirect('/admin/orders'); }
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  req.flash('success', `Order #${req.params.id} marked as ${status}.`);
  res.redirect('/admin/orders');
});

router.post('/orders/:id/push', async (req, res) => {
  const order = await db.get(
    `SELECT o.*, s.provider_id, s.provider_service_id, s.name AS service_name FROM orders o
     JOIN services s ON s.id = o.service_id WHERE o.id = ?`, [req.params.id]
  );
  if (!order) { req.flash('error', 'Order not found.'); return res.redirect('/admin/orders'); }
  if (!order.provider_id || !order.provider_service_id) {
    req.flash('error', 'This service is not linked to a provider.');
    return res.redirect('/admin/orders');
  }
  const provider = await db.get("SELECT * FROM providers WHERE id = ? AND status = 'active'", [order.provider_id]);
  if (!provider) { req.flash('error', 'Linked provider is not active.'); return res.redirect('/admin/orders'); }
  try {
    const resp = await callProvider(provider, 'add', {
      service: order.provider_service_id, link: order.link, quantity: order.quantity,
    });
    const providerOrderId = String(resp.order ?? resp.id ?? '');
    if (!providerOrderId) throw new Error('Provider did not return an order id');
    await db.run("UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?",
      [providerOrderId, order.id]);
    req.flash('success', `Order pushed to provider. Provider order id: ${providerOrderId}`);
  } catch (e) {
    req.flash('error', 'Push failed: ' + e.message);
  }
  res.redirect('/admin/orders');
});

router.post('/orders/:id/refresh', async (req, res) => {
  const order = await db.get(
    `SELECT o.*, s.provider_id FROM orders o
     JOIN services s ON s.id = o.service_id WHERE o.id = ?`, [req.params.id]
  );
  if (!order) { req.flash('error', 'Order not found.'); return res.redirect('/admin/orders'); }
  if (!order.provider_order_id || !order.provider_id) {
    req.flash('error', 'Order has no provider order id yet.');
    return res.redirect('/admin/orders');
  }
  const provider = await db.get('SELECT * FROM providers WHERE id = ?', [order.provider_id]);
  try {
    const resp = await callProvider(provider, 'status', { order: order.provider_order_id });
    const pStatus = String(resp.status || resp.order_status || '').toLowerCase();
    const map = { completed: 'completed', complete: 'completed', done: 'completed', processing: 'processing', inprogress: 'inprogress', in_progress: 'inprogress', pending: 'pending', partial: 'partial', canceled: 'canceled', cancelled: 'canceled', refunded: 'canceled' };
    const newStatus = map[pStatus] || order.status;
    const startCount = resp.start_count != null ? parseInt(resp.start_count, 10) || 0 : order.start_count;
    const remains = resp.remains != null ? parseInt(resp.remains, 10) || 0 : order.remains;
    await db.run('UPDATE orders SET status = ?, start_count = ?, remains = ? WHERE id = ?',
      [newStatus, startCount, remains, order.id]);
    req.flash('success', `Order status refreshed: ${newStatus} (remains: ${remains})`);
  } catch (e) {
    req.flash('error', 'Refresh failed: ' + e.message);
  }
  res.redirect('/admin/orders');
});

// ---------------- Users (paginated, 50/page) ----------------
router.get('/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  const { page, perPage } = getPagination(req);

  let where = ' WHERE 1=1';
  const params = [];
  if (q) { where += ' AND (u.username LIKE ? OR u.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  const totalRow = await db.get(`SELECT COUNT(*) AS c FROM users u${where}`, params);
  const pg = pageMeta(totalRow.c, page, perPage);

  const users = await db.query(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
     FROM users u${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, pg.offset]
  );
  res.render('admin/users', {
    title: 'Users', users, q,
    page: pg.page, pages: pg.pages, total: pg.total, qs: buildQs(req.query),
  });
});

router.get('/users/:id', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }
  const [orders, funds, logs] = await Promise.all([
    db.query(`SELECT o.*, s.name AS service_name FROM orders o JOIN services s ON s.id=o.service_id
              WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 20`, [user.id]),
    db.query(`SELECT f.*, m.name AS method_name FROM fund_requests f
              LEFT JOIN payment_methods m ON m.id=f.method_id
              WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 20`, [user.id]),
    db.query('SELECT * FROM balance_logs WHERE user_id = ? ORDER BY id DESC LIMIT 20', [user.id]),
  ]);
  res.render('admin/user_detail', { title: 'User: ' + user.username, user, orders, funds, logs });
});

router.post('/users/:id/balance', async (req, res) => {
  const amount = parseFloat(req.body.amount);
  const reason = (req.body.reason || 'Manual adjustment').trim().slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) {
    req.flash('error', 'Enter a non-zero amount.');
    return res.redirect('/admin/users/' + req.params.id);
  }
  const now = new Date().toISOString();
  await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, req.params.id]);
  await db.run('INSERT INTO balance_logs (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)',
    [req.params.id, amount, 'Admin: ' + reason, now]);
  req.flash('success', `Balance ${amount > 0 ? 'credited' : 'debited'} by ${Math.abs(amount)}.`);
  res.redirect('/admin/users/' + req.params.id);
});

router.post('/users/:id/status', async (req, res) => {
  const status = req.body.status === 'disabled' ? 'disabled' : 'active';
  await db.run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
  req.flash('success', 'User ' + status + '.');
  res.redirect('/admin/users/' + req.params.id);
});

// ---------------- Fund requests (paginated, 50/page) ----------------
router.get('/funds', async (req, res) => {
  const status = (req.query.status || 'pending').trim();
  const allowed = ['pending', 'approved', 'rejected'];
  const f = allowed.includes(status) ? status : 'pending';
  const { page, perPage } = getPagination(req);

  const totalRow = await db.get(
    `SELECT COUNT(*) AS c FROM fund_requests fr WHERE fr.status = ?`, [f]
  );
  const pg = pageMeta(totalRow.c, page, perPage);

  const requests = await db.query(
    `SELECT fr.*, u.username, m.name AS method_name FROM fund_requests fr
     JOIN users u ON u.id = fr.user_id LEFT JOIN payment_methods m ON m.id = fr.method_id
     WHERE fr.status = ? ORDER BY fr.id DESC LIMIT ? OFFSET ?`,
    [f, perPage, pg.offset]
  );
  const pendingCount = await db.get("SELECT COUNT(*) AS c FROM fund_requests WHERE status='pending'");
  res.render('admin/funds', {
    title: 'Fund requests', requests, statusFilter: f, pendingCount: pendingCount.c,
    page: pg.page, pages: pg.pages, total: pg.total, qs: buildQs(req.query),
  });
});

router.post('/funds/:id/approve', async (req, res) => {
  const fr = await db.get("SELECT * FROM fund_requests WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!fr) { req.flash('error', 'Request not found or already processed.'); return res.redirect('/admin/funds'); }
  const now = new Date().toISOString();
  await db.run("UPDATE fund_requests SET status = 'approved' WHERE id = ?", [fr.id]);
  await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [fr.amount, fr.user_id]);
  await db.run('INSERT INTO balance_logs (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)',
    [fr.user_id, fr.amount, 'Fund request #' + fr.id + ' approved', now]);

  // Referral commission for the referrer
  const funder = await db.get('SELECT referred_by FROM users WHERE id = ?', [fr.user_id]);
  const pctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_percent'");
  const pct = pctRow ? Number(pctRow.value) || 0 : 0;
  if (funder && funder.referred_by && pct > 0) {
    const commission = Math.round(fr.amount * pct / 100 * 100) / 100;
    if (commission > 0) {
      await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [commission, funder.referred_by]);
      await db.run('INSERT INTO balance_logs (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)',
        [funder.referred_by, commission, `Referral commission (${pct}% of fund request #${fr.id})`, now]);
    }
  }

  req.flash('success', `Approved. ${fr.amount} credited to user.`);
  res.redirect('/admin/funds');
});

router.post('/funds/:id/reject', async (req, res) => {
  const fr = await db.get("SELECT * FROM fund_requests WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!fr) { req.flash('error', 'Request not found or already processed.'); return res.redirect('/admin/funds'); }
  const note = (req.body.admin_note || '').trim().slice(0, 300);
  await db.run("UPDATE fund_requests SET status = 'rejected', admin_note = ? WHERE id = ?", [note, fr.id]);
  req.flash('success', 'Fund request rejected.');
  res.redirect('/admin/funds');
});

// ---------------- Payment methods ----------------
router.get('/payments', async (req, res) => {
  const methods = await db.query('SELECT * FROM payment_methods ORDER BY position, id');
  res.render('admin/payments', { title: 'Payment methods', methods });
});

router.post('/payments', async (req, res) => {
  await db.insert(
    'INSERT INTO payment_methods (name, type, account_title, account_number, instructions, status, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [(req.body.name || '').trim(), (req.body.type || 'manual').trim(),
     (req.body.account_title || '').trim(), (req.body.account_number || '').trim(),
     (req.body.instructions || '').trim(),
     req.body.status === 'inactive' ? 'inactive' : 'active', parseInt(req.body.position, 10) || 0]
  );
  req.flash('success', 'Payment method added.');
  res.redirect('/admin/payments');
});

router.post('/payments/:id', async (req, res) => {
  await db.run(
    'UPDATE payment_methods SET name=?, type=?, account_title=?, account_number=?, instructions=?, status=?, position=? WHERE id=?',
    [(req.body.name || '').trim(), (req.body.type || 'manual').trim(),
     (req.body.account_title || '').trim(), (req.body.account_number || '').trim(),
     (req.body.instructions || '').trim(),
     req.body.status === 'inactive' ? 'inactive' : 'active', parseInt(req.body.position, 10) || 0, req.params.id]
  );
  req.flash('success', 'Payment method updated.');
  res.redirect('/admin/payments');
});

router.post('/payments/:id/delete', async (req, res) => {
  const used = await db.get('SELECT COUNT(*) AS c FROM fund_requests WHERE method_id = ?', [req.params.id]);
  if (used.c > 0) { req.flash('error', 'Cannot delete: fund requests use this method.'); }
  else { await db.run('DELETE FROM payment_methods WHERE id=?', [req.params.id]); req.flash('success', 'Deleted.'); }
  res.redirect('/admin/payments');
});

// ---------------- Tickets (paginated, 50/page) ----------------
router.get('/tickets', async (req, res) => {
  const status = (req.query.status || '').trim();
  const { page, perPage } = getPagination(req);

  let where = ' WHERE 1=1';
  const params = [];
  if (status === 'open' || status === 'closed') { where += ' AND t.status = ?'; params.push(status); }

  const totalRow = await db.get(`SELECT COUNT(*) AS c FROM tickets t${where}`, params);
  const pg = pageMeta(totalRow.c, page, perPage);

  const tickets = await db.query(
    `SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id${where}
     ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, pg.offset]
  );
  res.render('admin/tickets', {
    title: 'Tickets', tickets, statusFilter: status,
    page: pg.page, pages: pg.pages, total: pg.total, qs: buildQs(req.query),
  });
});

router.get('/tickets/:id', async (req, res) => {
  const ticket = await db.get(
    'SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?',
    [req.params.id]
  );
  if (!ticket) { req.flash('error', 'Ticket not found.'); return res.redirect('/admin/tickets'); }
  const messages = await db.query(
    `SELECT m.*, us.username FROM ticket_messages m
     JOIN users us ON us.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id ASC`, [ticket.id]
  );
  res.render('admin/ticket_view', { title: 'Ticket #' + ticket.id, ticket, messages });
});

router.post('/tickets/:id', async (req, res) => {
  const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!ticket) { req.flash('error', 'Ticket not found.'); return res.redirect('/admin/tickets'); }
  const message = (req.body.message || '').trim();
  const action = req.body.action;
  const now = new Date().toISOString();
  if (message) {
    await db.insert('INSERT INTO ticket_messages (ticket_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
      [ticket.id, res.locals.currentUser.id, message, now]);
  }
  if (action === 'close') await db.run("UPDATE tickets SET status = 'closed' WHERE id = ?", [ticket.id]);
  else if (action === 'reopen') await db.run("UPDATE tickets SET status = 'open' WHERE id = ?", [ticket.id]);
  req.flash('success', 'Ticket updated.');
  res.redirect('/admin/tickets/' + ticket.id);
});

// ---------------- Announcements ----------------
router.get('/announcements', async (req, res) => {
  const announcements = await db.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 100');
  res.render('admin/announcements', { title: 'Announcements', announcements });
});

router.post('/announcements', async (req, res) => {
  await db.insert(
    'INSERT INTO announcements (title, message, status, created_at) VALUES (?, ?, ?, ?)',
    [(req.body.title || '').trim().slice(0, 150), (req.body.message || '').trim(),
     req.body.status === 'archived' ? 'archived' : 'active', new Date().toISOString()]
  );
  req.flash('success', 'Announcement published.');
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id', async (req, res) => {
  await db.run('UPDATE announcements SET title = ?, message = ?, status = ? WHERE id = ?',
    [(req.body.title || '').trim().slice(0, 150), (req.body.message || '').trim(),
     req.body.status === 'archived' ? 'archived' : 'active', req.params.id]);
  req.flash('success', 'Announcement updated.');
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', async (req, res) => {
  await db.run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  req.flash('success', 'Announcement deleted.');
  res.redirect('/admin/announcements');
});

// ---------------- Settings ----------------
router.get('/settings', async (req, res) => {
  const rows = await db.query('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  res.render('admin/settings', {
    title: 'Settings', s,
    dbBackend: db.isPostgres() ? 'PostgreSQL' : 'SQLite',
    nodeVersion: process.version,
  });
});

const SETTING_KEYS = ['site_name', 'currency', 'referral_commission_percent',
  'loyalty_tiers', 'telegram_bot_token', 'telegram_chat_id'];

router.post('/settings', async (req, res) => {
  let hadError = false;
  for (const k of SETTING_KEYS) {
    let v = (req.body[k] || '').trim();
    if (k === 'loyalty_tiers') {
      // Validate JSON; keep old value on invalid input
      try {
        const parsed = JSON.parse(v || '[]');
        if (!Array.isArray(parsed)) throw new Error('not an array');
        v = JSON.stringify(parsed);
      } catch (e) {
        req.flash('error', 'Loyalty tiers must be a valid JSON array — other settings saved, tiers unchanged.');
        hadError = true;
        continue;
      }
    }
    if (k === 'referral_commission_percent' && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 50)) {
      req.flash('error', 'Referral commission must be between 0 and 50%.');
      hadError = true;
      continue;
    }
    const exists = await db.get('SELECT key FROM settings WHERE key = ?', [k]);
    if (exists) await db.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
    else await db.insert('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }
  clearCache(); // telegram config may have changed
  if (!hadError) req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.post('/settings/test-telegram', async (req, res) => {
  // Save token/chat id first if provided on the form
  for (const k of ['telegram_bot_token', 'telegram_chat_id']) {
    const v = (req.body[k] || '').trim();
    const exists = await db.get('SELECT key FROM settings WHERE key = ?', [k]);
    if (exists) await db.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
    else await db.insert('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }
  clearCache();
  const ok = await sendMessage('✅ <b>Test message</b> from your SMM panel. Telegram notifications are working.');
  req.flash(ok ? 'success' : 'error',
    ok ? 'Test message sent! Check your Telegram.' : 'Could not send. Check the bot token and chat ID.');
  res.redirect('/admin/settings');
});

module.exports = router;
