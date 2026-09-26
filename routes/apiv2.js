const express = require('express');
const db = require('../db');
const { getUserTier } = require('../lib/loyalty');

const router = express.Router();

// All params may come as JSON body or form-encoded.
function params(req) {
  return Object.assign({}, req.query, req.body);
}

async function apiUser(key) {
  if (!key) return null;
  const u = await db.get("SELECT * FROM users WHERE api_key = ? AND status = 'active'", [key]);
  return u;
}

router.post('/', async (req, res) => {
  const p = params(req);
  const user = await apiUser(p.key);
  if (!user) return res.json({ status: 'error', error: 'Invalid API key' });

  const action = (p.action || '').toLowerCase();
  const now = new Date().toISOString();

  try {
    if (action === 'services') {
      const services = await db.query(
        `SELECT s.id AS service, s.name, s.type, s.rate_per_1000 AS rate,
                s.min, s.max, c.name AS category
         FROM services s LEFT JOIN categories c ON c.id = s.category_id
         WHERE s.status = 'active' ORDER BY s.id`
      );
      return res.json({ status: 'success', services });
    }

    if (action === 'add') {
      const serviceId = parseInt(p.service, 10);
      const link = (p.link || '').trim();
      const quantity = parseInt(p.quantity, 10);
      const service = await db.get('SELECT * FROM services WHERE id = ? AND status = ?', [serviceId, 'active']);
      if (!service) return res.json({ status: 'error', error: 'Invalid service id' });
      if (!link) return res.json({ status: 'error', error: 'Link is required' });
      if (!Number.isInteger(quantity) || quantity < service.min || quantity > service.max) {
        return res.json({ status: 'error', error: `Quantity must be between ${service.min} and ${service.max}` });
      }
      const charge = Math.round((service.rate_per_1000 * quantity / 1000) * 100) / 100;
      // Loyalty discount (same tiers as the web panel)
      const tier = await getUserTier(user.id);
      const finalCharge = Math.round(charge * (1 - tier.discount_pct / 100) * 100) / 100;
      const me = await db.get('SELECT balance FROM users WHERE id = ?', [user.id]);
      if (me.balance < finalCharge) return res.json({ status: 'error', error: 'Insufficient balance' });

      await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [finalCharge, user.id]);
      await db.run('INSERT INTO balance_logs (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)',
        [user.id, -finalCharge, 'API order', now]);
      const orderId = await db.insert(
        `INSERT INTO orders (user_id, service_id, link, quantity, charge, status, start_count, remains, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        [user.id, service.id, link, quantity, finalCharge, quantity, now]
      );
      return res.json({ status: 'success', order: orderId });
    }

    if (action === 'status') {
      const orderId = parseInt(p.order, 10);
      const order = await db.get('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, user.id]);
      if (!order) return res.json({ status: 'error', error: 'Order not found' });
      return res.json({
        status: 'success',
        order: order.id,
        order_status: order.status,
        charge: order.charge,
        start_count: order.start_count,
        remains: order.remains,
      });
    }

    if (action === 'balance') {
      const me = await db.get('SELECT balance FROM users WHERE id = ?', [user.id]);
      const currency = (await db.get("SELECT value FROM settings WHERE key = 'currency'")) || { value: 'PKR' };
      return res.json({ status: 'success', balance: me.balance, currency: currency.value });
    }

    return res.json({ status: 'error', error: 'Unknown action. Use: services, add, status, balance' });
  } catch (e) {
    return res.json({ status: 'error', error: 'Server error' });
  }
});

module.exports = router;
