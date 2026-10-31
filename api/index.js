// backend/api/index.js
// Vercel Serverless Function entry point when backend is deployed as its own repository
const app = require('../server');

module.exports = (req, res) => {
  return app(req, res);
};
