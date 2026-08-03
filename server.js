// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// ---- Middleware & helpers ---------------------------------------------------
// (Imported BEFORE routes so that every require() invocation has its exports
//  ready for anyone who needs them. This reordering also makes the file's
//  flow easier to read: setup → middleware → routes → fallbacks.)

const { auditMiddleware } = require('./middleware/audit');
const { sanitizeRequestBody } = require('./utils/validators');

// ---- Route modules ---------------------------------------------------------
// Loaded after middleware & helpers because some routes require() them
// (e.g. auth.js uses helpers.successResponse / errorResponse, and imports
//  middleware/auth and middleware/audit directly).

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const eventRoutes = require('./routes/events');
const votingRoutes = require('./routes/voting');
const resourceRoutes = require('./routes/resources');
const timetableRoutes = require('./routes/timetable');
const careerRoutes = require('./routes/career');
const paymentRoutes = require('./routes/payment');
const storageRoutes = require('./routes/storage');
const uploadRoutes = require('./routes/upload');
const adminRoutes = require('./routes/admin');

const app = express();

const frontendRoot = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendRoot));

// ============================================
// SECURITY & MIDDLEWARE
// ============================================

// Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable if using inline scripts
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://nacos-tau-chapter.netlify.app',
  credentials: true,
  optionsSuccessStatus: 200
}));

// Logging
app.use(morgan('combined'));

// JSON parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global input sanitization: escapes HTML entities in all body/query/params text
// fields to prevent stored XSS attacks (passwords/proofs/tokens are skipped internally)
app.use(sanitizeRequestBody);

// Audit middleware: auto-log response status, timing, user context, path
// Runs after body parsing so req.body is accessible for POST/PUT auditing
app.use(auditMiddleware);

// ============================================
// GLOBAL RATE LIMITING
// ============================================

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Math.max(1, parseInt(process.env.GLOBAL_RATE_LIMIT || '100', 10)),
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Trust proxy (Railway / Cloudflare / Nginx) so rate limits key on the real client IP
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', /^(true|1)$/i.test(tp) ? true : tp);
}

app.use('/api/', globalLimiter);

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/voting', votingRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/timetables', timetableRoutes);
app.use('/api/career', careerRoutes);
app.use('/api/payments', paymentRoutes);
// Storage admin routes (service_role backed, admin only)
app.use('/api/storage', storageRoutes);
// File upload/delete/list routes (generic bucket-key paths: /upload/:bucket, etc.)
// Upload router already uses path params like `/upload/:bucket` internally, so
// mount at `/api` to produce `/api/upload/:bucket`, `/api/delete/:bucket`, etc.
app.use('/api', uploadRoutes);
// Admin-only generic table write pass-through (events/past_questions/timetables/etc.)
// Uses service_role client to bypass anon-key RLS 42501 INSERT violations.
app.use('/api/admin', adminRoutes);

// Serve root and fallback to index.html for frontend routes
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendRoot, 'index.html'));
});

app.get('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({
      error: 'Route not found',
      path: req.originalUrl
    });
  }
  res.sendFile(path.join(frontendRoot, 'index.html'));
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  // Don't expose internal errors in production
  if (process.env.NODE_ENV === 'production' && status === 500) {
    res.status(status).json({
      error: 'An unexpected error occurred'
    });
  } else {
    res.status(status).json({
      error: message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 NACOS API Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL}`);
});

module.exports = app; // For testing