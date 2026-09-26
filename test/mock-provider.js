/**
 * Mock SMM provider API for local testing.
 * Run: node test/mock-provider.js  (listens on http://localhost:4001)
 *
 * Implements the classic form-encoded SMM API:
 *   action=services -> list of services
 *   action=balance  -> balance
 *   action=add      -> creates an order, returns { order }
 *   action=status   -> returns status/start_count/remains for an order
 */
const http = require('http');

const PORT = 4001;

const services = [
  { service: 101, name: 'Mock Instagram Followers | Test', category: 'Mock Instagram', type: 'default', rate: '100.00', min: 100, max: 100000 },
  { service: 102, name: 'Mock TikTok Views | Test', category: 'Mock TikTok', type: 'default', rate: '10.00', min: 100, max: 5000000 },
];

let nextOrderId = 5000;
const orders = {}; // providerOrderId -> { status, start_count, remains }

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const ct = req.headers['content-type'] || '';
    let p = {};
    try {
      if (ct.includes('application/json')) p = JSON.parse(body);
      else p = Object.fromEntries(new URLSearchParams(body));
    } catch (e) { /* ignore */ }

    if (p.key !== 'test-key-123') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid API key' }));
    }

    let out;
    if (p.action === 'services') out = services;
    else if (p.action === 'balance') out = { balance: '2500.75', currency: 'USD' };
    else if (p.action === 'add') {
      const id = String(nextOrderId++);
      orders[id] = { status: 'processing', start_count: 120, remains: Number(p.quantity) || 0 };
      out = { order: id };
    } else if (p.action === 'status') {
      const o = orders[String(p.order)];
      out = o || { error: 'Order not found' };
    } else out = { error: 'Unknown action' };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, () => console.log(`Mock provider listening on http://localhost:${PORT}`));
module.exports = server;
