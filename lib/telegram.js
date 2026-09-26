/**
 * Telegram admin notifications (fire-and-forget).
 * Configure via admin Settings: telegram_bot_token + telegram_chat_id.
 * All failures are swallowed: notifications must never crash or slow a request.
 */
const db = require('../db');

let cached = null;
let cachedAt = 0;

async function getConfig() {
  // Cache for 60s to avoid a settings query on every order.
  if (cached && Date.now() - cachedAt < 60000) return cached;
  try {
    const rows = await db.query(
      "SELECT key, value FROM settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id')"
    );
    const cfg = { token: '', chatId: '' };
    for (const r of rows) {
      if (r.key === 'telegram_bot_token') cfg.token = (r.value || '').trim();
      if (r.key === 'telegram_chat_id') cfg.chatId = (r.value || '').trim();
    }
    cached = cfg; cachedAt = Date.now();
    return cfg;
  } catch (e) {
    return { token: '', chatId: '' };
  }
}

function clearCache() { cached = null; }

async function sendMessage(text) {
  const { token, chatId } = await getConfig();
  if (!token || !chatId) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    return false; // never throw
  }
}

// Fire-and-forget wrapper for request handlers: do NOT await this.
function notifyAdmin(text) {
  sendMessage(text).catch(() => {});
}

module.exports = { sendMessage, notifyAdmin, clearCache, getConfig };
