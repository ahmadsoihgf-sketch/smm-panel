/**
 * Netlify serverless entry point.
 * Netlify invokes the exported handler per request; we wait for the DB
 * initialization promise before handing the request to Express.
 */
const serverless = require('serverless-http');
const app = require('../../server');

const handler = serverless(app);

module.exports.handler = async (event, context) => {
  await app._ready;
  return handler(event, context);
};
