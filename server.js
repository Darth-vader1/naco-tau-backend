// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// ============================================
// SECURITY & LOGGING CONFIGURATION
// ============================================

// Initialize Sentry first (captures all errors including startup)
const { initSentry, sentryUserContext } = require('./config/sentry');
const { logger, morganLogger } = require('./config/logger');
const {
  httpsRedirect,
  helmetConfig,
  csrfProtection,
  csrfErrorHandler,
  additionalSecurityHeaders,
  securityEventLogger,
  ipWhitelist,
  cookieParser
} = require('./config/security');

// ---- Middleware & helpers ---------------------------------------------------
// (Imported BEFORE routes so that every require() invocation has its exports
//  ready for anyone who needs them. This reordering also makes the file's
//  flow easier to read: setup → middleware → routes → fallbacks.)

const { auditMiddleware } = require('./middleware/audit');
const { sanitizeRequestBody } = require('./utils/validators');
const { trackSession, initializeSessionManager } = require('./middleware/sessionManager');

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
const hackathonRoutes = require('./routes/hackathons');
const pastExecutiveRoutes = require('./routes/pastExecutives');

const app = express();

// Initialize Sentry (must be before any other middleware)
const sentry = initSentry(app);
if (sentry.isEnabled) {
  app.use(sentry.requestHandler);
  logger.info('✅ Sentry error tracking enabled');
}

// Frontend is deployed separately, so we don't serve static files here.
// app.use(express.static(frontendRoot));

// ============================================
// SECURITY & MIDDLEWARE
// ============================================

// HTTPS redirect (production only)
app.use(httpsRedirect);
logger.info('✅ HTTPS enforcement enabled (production only)');

// Enhanced Helmet for security headers (CSP, HSTS, etc.)
app.use(helmetConfig);
logger.info('✅ Security headers configured (Helmet + CSP + HSTS)');

// Additional custom security headers
app.use(additionalSecurityHeaders);

// CORS configuration
const allowedOrigins = [
  'https://nacos-tau-portal.netlify.app',
  'https://nacos-tau-chapter.netlify.app', // Legacy URL (if still in use)
  'http://localhost:5000',  // Backend serving frontend
  'http://localhost:5500',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5504',
  'http://localhost:5504',
  'http://127.0.0.1:8080',
];

// Add custom FRONTEND_URL from env if provided
if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

// Remove localhost origins in production unless ALLOW_LOCAL_CORS is true
const productionOrigins = (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_CORS !== 'true')
  ? allowedOrigins.filter(origin => !origin.includes('localhost') && !origin.includes('127.0.0.1'))
  : allowedOrigins;

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or same-origin)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (productionOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.security.suspiciousActivity('CORS_BLOCKED', { origin });
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  optionsSuccessStatus: 200
}));

// Preflight (OPTIONS) is handled by the cors() middleware above using the allow-list.
// (Do NOT add app.options('*', cors()) — it would answer preflights with a wildcard origin.)

// Logging with Winston (replaces Morgan)
app.use(morganLogger);
logger.info('✅ Structured logging enabled (Winston)');

// Cookie parser (required for CSRF)

// Cookie parser (required for CSRF)
app.use(cookieParser());
logger.info('✅ Cookie parser enabled');

// JSON parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global input sanitization: escapes HTML entities in all body/query/params text
// fields to prevent stored XSS attacks (passwords/proofs/tokens are skipped internally)
app.use(sanitizeRequestBody);
logger.info('✅ XSS protection enabled (HTML entity escaping)');

// Sentry user context (attach user info to error reports)
if (sentry.isEnabled) {
  app.use(sentryUserContext);
}

// Audit middleware: auto-log response status, timing, user context, path
// Runs after body parsing so req.body is accessible for POST/PUT auditing
app.use(auditMiddleware);

// IP whitelist for admin routes (optional, configured via ADMIN_IP_WHITELIST env var)
if (process.env.ADMIN_IP_WHITELIST) {
  app.use(ipWhitelist);
  logger.info('✅ IP whitelist enabled for admin routes');
}

// ============================================
// GLOBAL RATE LIMITING
// ============================================

// Extract token helper for rate limiting key generation
const { extractToken } = require('./middleware/auth');
const crypto = require('crypto');

// Redis for persistent rate limiting across deployments
let Redis;
let RedisStore;
try {
  Redis = require('ioredis');
  const rlr = require('rate-limit-redis');
  RedisStore = rlr.default || rlr;
} catch (e) {
  // If not installed yet, we'll fall back to memory
}

let redisStore;
if (process.env.REDIS_URL && RedisStore) {
  const redisClient = new Redis(process.env.REDIS_URL);
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  
  redisStore = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
  console.log('✅ Redis Rate Limiting Enabled');
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Math.max(1, parseInt(process.env.GLOBAL_RATE_LIMIT || '300', 10)),
  message: {
    error: 'Too many requests, please slow down and try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore, // Uses Redis if configured, otherwise automatically falls back to Memory
  // Key on authenticated user token hash if present, fallback to client IP.
  // This prevents campus Wi-Fi (where hundreds of students share 1 IP) from triggering a mass block.
  keyGenerator: (req) => {
    const token = extractToken(req);
    if (token) {
      return `auth_${crypto.createHash('sha256').update(token).digest('hex').substring(0, 16)}`;
    }
    return req.ip;
  },
  validate: { trustProxy: false }
});

// Trust proxy (Railway / Cloudflare / Nginx) so rate limits key on the real client IP
// Use 1 hop for Railway (more secure than true)
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  // If set to 'true' or '1', trust only 1 proxy hop (Railway's proxy)
  // This is more secure than trusting all proxies
  if (/^(true|1)$/i.test(tp)) {
    app.set('trust proxy', 1); // Trust only the first proxy
  } else {
    app.set('trust proxy', tp); // Use custom value (e.g., loopback, specific IPs)
  }
}

app.use('/api/', globalLimiter);

// Session tracking: monitor user sessions and detect expired/stale sessions.
// Mounted AFTER the rate limiter on purpose: it makes an outbound Supabase call
// per request and must not be reachable by unthrottled traffic.
app.use(trackSession);
logger.info('✅ Session tracking enabled');

// ============================================
// ROUTES
// ============================================

// Health check (no auth, no CSRF)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    security: {
      https: process.env.NODE_ENV === 'production',
      csrf: process.env.ENABLE_CSRF === 'true',
      sentry: sentry.isEnabled
    }
  });
});

// CSRF token endpoint (must be called before any CSRF-protected requests)
// Frontend should fetch this token and include it in subsequent requests
if (process.env.ENABLE_CSRF === 'true') {
  app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ 
      csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : 'bearer-token-bypass',
      expires: new Date(Date.now() + 3600000).toISOString() // 1 hour
    });
  });
  logger.info('✅ CSRF protection enabled for state-changing routes');
}

// Honeypot endpoints (to detect/log automated scanners)
// Mounted BEFORE router endpoints so unauthenticated probes trigger threat alerts
const { createHoneypotUpload } = require('./middleware/uploadSecurity');
app.post('/api/admin/backup', createHoneypotUpload());
app.post('/api/upload/shell', createHoneypotUpload());
app.get('/api/.env', (req, res) => {
  logger.security.suspiciousActivity('HONEYPOT_ENV_ACCESS', {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  res.status(404).json({ error: 'Not found' });
});
logger.info('✅ Honeypot endpoints configured for threat detection');

// API Routes (no CSRF for read-only routes)
app.use('/api/auth', authRoutes); // Auth has its own rate limiting
app.use('/api/students', studentRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/voting', process.env.ENABLE_CSRF === 'true' ? csrfProtection : [], votingRoutes); // CSRF on voting
app.use('/api/resources', resourceRoutes);
app.use('/api/timetables', timetableRoutes);
app.use('/api/career', careerRoutes);
app.use('/api/payments', process.env.ENABLE_CSRF === 'true' ? csrfProtection : [], paymentRoutes); // CSRF on payments
app.use('/api/hackathons', hackathonRoutes);
app.use('/api/past-executives', pastExecutiveRoutes);
const emailRoutes = require('./routes/email');
app.use('/api/emails', process.env.ENABLE_CSRF === 'true' ? csrfProtection : [], emailRoutes); // CSRF on emails
// Storage admin routes (service_role backed, admin only)
app.use('/api/storage', storageRoutes);
// File upload/delete/list routes (generic bucket-key paths: /upload/:bucket, etc.)
// Upload router already uses path params like `/upload/:bucket` internally, so
// mount at `/api` to produce `/api/upload/:bucket`, `/api/delete/:bucket`, etc.
app.use('/api', uploadRoutes);
// Admin-only generic table write pass-through (events/past_questions/timetables/etc.)
// Uses service_role client to bypass anon-key RLS 42501 INSERT violations.
// CSRF protection on all admin write operations
app.use('/api/admin', process.env.ENABLE_CSRF === 'true' ? csrfProtection : [], adminRoutes);

// Audit logs route (admin only)
const auditLogRoutes = require('./routes/auditLogs');
app.use('/api/audit-logs', auditLogRoutes);

// Serve root
app.get('/', (req, res) => {
  res.json({ message: 'NACOS API is running!' });
});

app.get('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// ============================================
// ERROR HANDLING
// ============================================

// CSRF error handler (must be before general error handler)
if (process.env.ENABLE_CSRF === 'true') {
  app.use(csrfErrorHandler);
}

// 404 handler
app.use((req, res) => {
  logger.api.response(req.method, req.path, 404, 0);
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Sentry error handler (must be before other error handlers)
if (sentry.isEnabled) {
  app.use(sentry.errorHandler);
}

// Global error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  // Log error with context
  logger.error('Unhandled error', {
    error: message,
    status,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: req.userId,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
  
  // Capture in Sentry
  if (sentry.isEnabled && status === 500) {
    sentry.captureException(err);
  }
  
  // Don't expose internal errors in production
  if (process.env.NODE_ENV === 'production' && status === 500) {
    res.status(status).json({
      error: 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(status).json({
      error: message,
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info('='.repeat(60));
  logger.info('🚀 NACOS API Server Started Successfully');
  logger.info('='.repeat(60));
  logger.info(`📡 Port: ${PORT}`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'Not configured'}`);
  logger.info(`🛡️  Security Features:`);
  logger.info(`   - HTTPS Enforcement: ${process.env.NODE_ENV === 'production' ? 'ENABLED' : 'DISABLED (dev only)'}`);
  logger.info(`   - CSRF Protection: ${process.env.ENABLE_CSRF === 'true' ? 'ENABLED' : 'DISABLED'}`);
  logger.info(`   - Sentry Monitoring: ${sentry.isEnabled ? 'ENABLED' : 'DISABLED'}`);
  logger.info(`   - Structured Logging: ENABLED`);
  logger.info(`   - Rate Limiting: ENABLED (${redisStore ? 'Upstash Redis' : 'Memory'} store)`);
  logger.info(`   - XSS Protection: ENABLED`);
  logger.info(`   - Session Management: ENABLED`);
  logger.info(`   - CORS: ENABLED (${productionOrigins.length} origins)`);
  if (process.env.ADMIN_IP_WHITELIST) {
    logger.info(`   - IP Whitelist: ENABLED (admin routes)`);
  }
  logger.info('='.repeat(60));
  logger.info('✅ All security features initialized');
  logger.info('📝 Logs location: console + ./logs/ (production)');
  logger.info('='.repeat(60));
  
  // Initialize session manager (starts background cleanup)
  initializeSessionManager();
});

// ============================================
// GRACEFUL SHUTDOWN & PROCESS-LEVEL ERROR HANDLING
// ============================================
let shuttingDown = false;
const shutdown = (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received: closing HTTP server...`);
  server.close(() => {
    logger.info('HTTP server closed. Exiting.');
    process.exit(exitCode);
  });
  // Force-exit if connections don't drain in time.
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(exitCode || 1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason && reason.stack ? reason.stack : String(reason) });
  if (sentry.isEnabled) sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  if (sentry.isEnabled) sentry.captureException(err);
  shutdown('uncaughtException', 1);
});

module.exports = app; // For testing