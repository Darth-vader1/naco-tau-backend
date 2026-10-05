// config/sentry.js
// Error tracking and monitoring with Sentry

const Sentry = require('@sentry/node');

/**
 * Initialize Sentry
 * Only initializes if SENTRY_DSN is set
 */
function initSentry(app) {
  if (!process.env.SENTRY_DSN) {
    console.log('ℹ️  Sentry not configured (SENTRY_DSN not set)');
    return {
      isEnabled: false,
      requestHandler: (req, res, next) => next(),
      errorHandler: (err, req, res, next) => next(err),
      captureException: () => {},
      captureMessage: () => {},
      setUser: () => {},
      setContext: () => {}
    };
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    
    // Performance monitoring
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    
    // Release tracking
    release: process.env.SENTRY_RELEASE || `nacos-backend@${require('../package.json').version}`,
    
    // Server name
    serverName: process.env.RAILWAY_DEPLOYMENT_ID || 'local',
    
    // Integrations
    integrations: [
      // HTTP integration
      new Sentry.Integrations.Http({ tracing: true }),
      // Express integration
      ...(app ? [new Sentry.Integrations.Express({ app })] : [])
    ],
    
    // Error filtering
    beforeSend(event, hint) {
      const error = hint.originalException;
      
      // Don't send validation errors (400-level)
      if (error?.status >= 400 && error?.status < 500) {
        return null;
      }
      
      // Don't send rate limit errors
      if (error?.message?.includes('rate limit')) {
        return null;
      }
      
      // Sanitize sensitive data
      if (event.request?.data) {
        event.request.data = sanitizeData(event.request.data);
      }
      
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      
      return event;
    },
    
    // Breadcrumbs
    beforeBreadcrumb(breadcrumb) {
      // Sanitize console breadcrumbs
      if (breadcrumb.category === 'console') {
        if (breadcrumb.message?.includes('password') || 
            breadcrumb.message?.includes('token') ||
            breadcrumb.message?.includes('secret')) {
          return null;
        }
      }
      
      // Sanitize HTTP breadcrumbs
      if (breadcrumb.category === 'http') {
        if (breadcrumb.data?.url) {
          breadcrumb.data.url = sanitizeUrl(breadcrumb.data.url);
        }
      }
      
      return breadcrumb;
    }
  });

  console.log('✅ Sentry initialized successfully');
  console.log(`   Environment: ${process.env.NODE_ENV}`);
  console.log(`   Traces Sample Rate: ${parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1') * 100}%`);

  return {
    isEnabled: true,
    requestHandler: Sentry.Handlers.requestHandler(),
    errorHandler: Sentry.Handlers.errorHandler(),
    captureException: Sentry.captureException,
    captureMessage: Sentry.captureMessage,
    setUser: Sentry.setUser,
    setContext: Sentry.setContext
  };
}

/**
 * Sanitize sensitive data before sending to Sentry
 */
function sanitizeData(data) {
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  
  const sanitized = Array.isArray(data) ? [] : {};
  const sensitiveKeys = [
    'password', 'token', 'secret', 'authorization', 'cookie',
    'api_key', 'apikey', 'access_token', 'refresh_token',
    'ssn', 'credit_card', 'cvv'
  ];
  
  for (const key in data) {
    const lowerKey = key.toLowerCase();
    
    if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof data[key] === 'object' && data[key] !== null) {
      sanitized[key] = sanitizeData(data[key]);
    } else {
      sanitized[key] = data[key];
    }
  }
  
  return sanitized;
}

/**
 * Sanitize URLs (remove query params that might contain tokens)
 */
function sanitizeUrl(url) {
  try {
    const urlObj = new URL(url);
    const sensitiveParams = ['token', 'key', 'secret', 'password', 'access_token'];
    
    sensitiveParams.forEach(param => {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, '[REDACTED]');
      }
    });
    
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Middleware to attach user context to Sentry
 */
function sentryUserContext(req, res, next) {
  if (req.user && Sentry.setUser) {
    Sentry.setUser({
      id: req.user.id,
      email: req.user.email ? `${req.user.email.substring(0, 3)}***` : undefined,
      role: req.userRole
    });
  }
  next();
}

/**
 * Capture exception with context
 */
function captureExceptionWithContext(error, context = {}) {
  if (!process.env.SENTRY_DSN) return;
  
  Sentry.withScope((scope) => {
    Object.keys(context).forEach(key => {
      scope.setContext(key, context[key]);
    });
    Sentry.captureException(error);
  });
}

/**
 * Capture message with context
 */
function captureMessageWithContext(message, level = 'info', context = {}) {
  if (!process.env.SENTRY_DSN) return;
  
  Sentry.withScope((scope) => {
    Object.keys(context).forEach(key => {
      scope.setContext(key, context[key]);
    });
    Sentry.captureMessage(message, level);
  });
}

module.exports = {
  initSentry,
  sentryUserContext,
  captureExceptionWithContext,
  captureMessageWithContext
};
