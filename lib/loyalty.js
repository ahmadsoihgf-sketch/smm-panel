/**
 * Loyalty tiers: users earn a standing discount based on lifetime spend.
 * tiers = [{ min_spent: Number, discount_pct: Number }, ...] sorted ascending.
 */
const db = require('../db');

function parseTiers(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map((t) => ({ min_spent: Number(t.min_spent) || 0, discount_pct: Number(t.discount_pct) || 0 }))
      .filter((t) => t.min_spent > 0 && t.discount_pct > 0)
      .sort((a, b) => a.min_spent - b.min_spent);
  } catch (e) {
    return [];
  }
}

async function getTiers() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'loyalty_tiers'");
  return parseTiers(row && row.value);
}

async function getLifetimeSpend(userId) {
  const r = await db.get('SELECT COALESCE(SUM(charge), 0) AS total FROM orders WHERE user_id = ?', [userId]);
  return Number(r.total) || 0;
}

/**
 * Returns { discount_pct, tier (the reached tier or null), next (next tier or null), spend }
 */
async function getUserTier(userId) {
  const [tiers, spend] = await Promise.all([getTiers(), getLifetimeSpend(userId)]);
  let reached = null, next = null;
  for (const t of tiers) {
    if (spend >= t.min_spent) reached = t;
    else { next = t; break; }
  }
  return { discount_pct: reached ? reached.discount_pct : 0, tier: reached, next, spend, tiers };
}

module.exports = { parseTiers, getTiers, getLifetimeSpend, getUserTier };
