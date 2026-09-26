/**
 * Generic SMM provider API client.
 *
 * Classic SMM reseller APIs are POST form-encoded: { key, action, ... } with
 * actions: services | add | status | balance. Some providers accept JSON too,
 * so we try form-encoded first, then JSON as a fallback.
 *
 * callProvider(provider, action, params) -> parsed JSON object.
 * Throws a descriptive Error on network failure, timeout, non-JSON or
 * provider-reported error. Never crashes the process.
 *
 * provider: { api_url, api_key }
 * action: 'services' | 'add' | 'status' | 'balance'
 * params: extra fields, e.g. { service, link, quantity } or { order }
 */

const http = require('http');
const https = require('https');

const TIMEOUT_MS = 15000;

function postRaw(url, body, contentType) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return reject(new Error('Invalid provider API URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'SMM-Panel/1.0',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Provider request timed out')); });
    req.on('error', (err) => reject(new Error('Provider request failed: ' + err.message)));
    req.write(body);
    req.end();
  });
}

function parseJson(body) {
  try { return JSON.parse(body); }
  catch (e) { throw new Error('Provider returned invalid JSON'); }
}

function checkProviderError(json) {
  if (json && typeof json.error === 'string' && json.error) {
    throw new Error('Provider error: ' + json.error);
  }
  return json;
}

async function callProvider(provider, action, params = {}) {
  if (!provider || !provider.api_url) throw new Error('Provider has no API URL configured');
  if (!provider.api_key) throw new Error('Provider has no API key configured');

  const payload = Object.assign({ key: provider.api_key, action }, params);

  // Attempt 1: classic form-encoded POST
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) form.append(k, String(v == null ? '' : v));
  try {
    const res = await postRaw(provider.api_url, form.toString(), 'application/x-www-form-urlencoded');
    if (res.statusCode >= 200 && res.statusCode < 300 && res.body.trim()) {
      return checkProviderError(parseJson(res.body));
    }
  } catch (e) {
    // fall through to JSON attempt (unless it was a provider-reported error)
    if (e.message.startsWith('Provider error:')) throw e;
  }

  // Attempt 2: JSON POST
  const res = await postRaw(provider.api_url, JSON.stringify(payload), 'application/json');
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('Provider HTTP error: ' + res.statusCode);
  }
  return checkProviderError(parseJson(res.body));
}

/** Fetch service list from provider and normalize to a common shape. */
async function fetchProviderServices(provider) {
  const data = await callProvider(provider, 'services');
  const list = Array.isArray(data) ? data : (Array.isArray(data.services) ? data.services : []);
  return list.map((s) => ({
    provider_service_id: String(s.service ?? s.id ?? ''),
    name: String(s.name ?? ''),
    type: String(s.type ?? 'default'),
    rate: Number(s.rate) || 0,          // provider rate per 1000 in provider currency
    min: Number(s.min) || 0,
    max: Number(s.max) || 0,
    category: String(s.category ?? ''),
  }));
}

/** Check provider balance (caches nothing; caller decides). */
async function fetchProviderBalance(provider) {
  const data = await callProvider(provider, 'balance');
  const b = data.balance ?? data.currency ?? null;
  return b === null ? null : Number(b);
}

module.exports = { callProvider, fetchProviderServices, fetchProviderBalance };
