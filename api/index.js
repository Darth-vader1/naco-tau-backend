// backend/api/index.js
// Vercel Serverless Function entry point with explicit diagnostics

let app;
let initError = null;

try {
  app = require('../server');
} catch (err) {
  initError = {
    message: err.message,
    stack: err.stack
  };
  console.error('❌ Failed to load server.js:', err);
}

module.exports = (req, res) => {
  if (initError) {
    return res.status(500).json({
      error: 'Backend Initialization Failed',
      details: initError.message,
      stack: initError.stack
    });
  }

  try {
    return app(req, res);
  } catch (err) {
    console.error('❌ Request error in handler:', err);
    return res.status(500).json({
      error: 'Request Execution Error',
      details: err.message
    });
  }
};
