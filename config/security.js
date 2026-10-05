const helmet = require('helmet');
const cookieParser = require('cookie-parser');

/**
 * HTTPS Enforcement Middleware
 * Redirects HTTP to HTTPS in production
 * Fixes M5: Host Header Injection by validating host against allowed patterns/env
 */
const httpsRedirect = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    // Render/Railway set x-forwarded-proto header
    if (req.header('x-forwarded-proto') !== 'https') {
      const host = req.header('host') || '';
      // Ensure host header only contains valid alphanumeric characters, dots, dashes, and port
      if (!/^[a-zA-Z0-9.\-]+(?::\d+)?$/.test(host)) {
        return res.status(400).send('Invalid Host header');
      }
      return res.redirect(308, `https://${host}${req.originalUrl || req.url}`);
    }
  }
  next();
};

/**
 * Enhanced Helmet Configuration
 * Sets secure HTTP headers
 */
const helmetConfig = helmet({
  // HSTS: Force HTTPS for 1 year
  hsts: {
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true
  },
  
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // Required for inline scripts (can be removed with nonce)
        "cdn.jsdelivr.net",
        "cdnjs.cloudflare.com",
        "unpkg.com"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // Required for inline styles
        "fonts.googleapis.com",
        "cdn.jsdelivr.net",
        "cdnjs.cloudflare.com"
      ],
      fontSrc: [
        "'self'",
        "fonts.gstatic.com",
        "cdnjs.cloudflare.com"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "https:",
        "blob:",
        process.env.SUPABASE_URL || "*.supabase.co"
      ],
      connectSrc: [
        "'self'",
        process.env.SUPABASE_URL || "*.supabase.co",
        "https://api.ipify.org" // For IP detection in audit logs
      ],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  
  // Additional security headers
  crossOriginEmbedderPolicy: false, // May interfere with third-party resources
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  
  // Prevent clickjacking
  frameguard: {
    action: 'deny'
  },
  
  // Hide X-Powered-By
  hidePoweredBy: true,
  
  // Prevent MIME sniffing
  noSniff: true,
  
  // Referrer policy
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  },
  
  // XSS Protection (legacy, but still useful)
  xssFilter: true
});

/**
 * CSRF Protection
 * In an Authorization: Bearer token architecture, browsers do not automatically attach
 * tokens across origins, neutralizing standard browser CSRF attacks without requiring csurf.
 * We provide a lightweight passthrough to keep interface backwards compatibility without the
 * vulnerable/archived csurf dependency.
 */
const csrfProtection = (req, res, next) => next();

const csrfErrorHandler = (err, req, res, next) => next(err);

/**
 * Secure Cookie Configuration Helper
 */
const secureCookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
};

/**
 * Security Headers Middleware
 * Additional custom security headers
 */
const additionalSecurityHeaders = (req, res, next) => {
  // Prevent browser from caching sensitive data
  if (req.path.startsWith('/api/admin') || req.path.includes('/profile')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  
  // Feature Policy / Permissions Policy
  res.set('Permissions-Policy', [
    'geolocation=()',
    'microphone=()',
    'camera=()',
    'payment=()',
    'usb=()',
    'magnetometer=()'
  ].join(', '));
  
  next();
};

/**
 * Rate Limit Response Headers
 * Add custom headers to rate limit responses
 */
const rateLimitHeaders = (req, res) => {
  res.set('X-RateLimit-Limit', req.rateLimit?.limit);
  res.set('X-RateLimit-Remaining', req.rateLimit?.remaining);
  res.set('X-RateLimit-Reset', new Date(req.rateLimit?.resetTime).toISOString());
};

/**
 * Security Event Logger
 * Logs security-relevant events
 */
const securityEventLogger = {
  logFailedLogin: (email, ip, reason) => {
    console.warn('[Security Event] Failed Login:', {
      event: 'FAILED_LOGIN',
      email: email ? email.substring(0, 3) + '***' : 'unknown',
      ip,
      reason,
      timestamp: new Date().toISOString()
    });
  },
  
  logRateLimitExceeded: (ip, path, limit) => {
    console.warn('[Security Event] Rate Limit Exceeded:', {
      event: 'RATE_LIMIT_EXCEEDED',
      ip,
      path,
      limit,
      timestamp: new Date().toISOString()
    });
  },
  
  logSuspiciousActivity: (type, details) => {
    console.warn('[Security Event] Suspicious Activity:', {
      event: 'SUSPICIOUS_ACTIVITY',
      type,
      details,
      timestamp: new Date().toISOString()
    });
  },
  
  logAdminAccess: (userId, email, action, ip) => {
    console.info('[Security Event] Admin Access:', {
      event: 'ADMIN_ACCESS',
      userId,
      email: email ? email.substring(0, 3) + '***' : 'unknown',
      action,
      ip,
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * IP Whitelist Middleware (for admin panel - optional)
 * Enable by setting ADMIN_IP_WHITELIST env var
 */
const ipWhitelist = (req, res, next) => {
  // Skip if not configured
  if (!process.env.ADMIN_IP_WHITELIST) {
    return next();
  }
  
  // Skip for non-admin routes
  if (!req.path.startsWith('/api/admin')) {
    return next();
  }
  
  const allowedIPs = process.env.ADMIN_IP_WHITELIST.split(',').map(ip => ip.trim());
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!allowedIPs.includes(clientIP)) {
    securityEventLogger.logSuspiciousActivity('IP_NOT_WHITELISTED', {
      ip: clientIP,
      path: req.path
    });
    
    return res.status(403).json({
      error: 'Access denied from this IP address'
    });
  }
  
  next();
};

module.exports = {
  httpsRedirect,
  helmetConfig,
  csrfProtection,
  csrfErrorHandler,
  secureCookieConfig,
  additionalSecurityHeaders,
  rateLimitHeaders,
  securityEventLogger,
  ipWhitelist,
  cookieParser
};
