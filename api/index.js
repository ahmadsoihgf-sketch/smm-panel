/**
 * Vercel serverless entry point.
 * Vercel invokes this exported handler per request; we wait for the DB
 * initialization promise before handing the request to Express.
 */
const app = require('../server');

module.exports = async (req, res) => {
  await app._ready;
  return app(req, res);
};
