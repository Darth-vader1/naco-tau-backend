// config/logger.js
// Structured logging with Winston

const winston = require('winston');
const path = require('path');

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define level colors
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Determine log level based on environment
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : process.env.LOG_LEVEL || 'info';
};

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define console format (prettier for development)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    (info) => {
      const { timestamp, level, message, ...meta } = info;
      const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
      return `${timestamp} [${level}]: ${message}${metaStr}`;
    }
  )
);

// Define transports
const transports = [
  // Console transport (always enabled)
  new winston.transports.Console({
    format: consoleFormat,
    handleExceptions: true,
    handleRejections: true
  })
];

// File transports (enabled in production or if LOG_TO_FILE is set)
if (process.env.NODE_ENV === 'production' || process.env.LOG_TO_FILE === 'true') {
  const logsDir = process.env.LOGS_DIR || path.join(__dirname, '..', 'logs');
  
  // Error log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      handleExceptions: true
    })
  );
  
  // Combined log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true
    })
  );
  
  // Security events log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'security.log'),
      level: 'warn',
      format,
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      handleExceptions: false
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: level(),
  levels,
  format,
  transports,
  exitOnError: false
});

// Create specialized loggers for different concerns

/**
 * Security Logger
 * For authentication, authorization, and security events
 */
logger.security = {
  failedLogin: (email, ip, reason) => {
    logger.warn('Failed login attempt', {
      category: 'security',
      event: 'FAILED_LOGIN',
      email: email ? `${email.substring(0, 3)}***` : 'unknown',
      ip,
      reason
    });
  },
  
  suspiciousActivity: (type, details) => {
    logger.warn('Suspicious activity detected', {
      category: 'security',
      event: 'SUSPICIOUS_ACTIVITY',
      type,
      details
    });
  },
  
  rateLimitExceeded: (ip, path, limit) => {
    logger.warn('Rate limit exceeded', {
      category: 'security',
      event: 'RATE_LIMIT_EXCEEDED',
      ip,
      path,
      limit
    });
  },
  
  adminAccess: (userId, email, action, ip) => {
    logger.info('Admin access', {
      category: 'security',
      event: 'ADMIN_ACCESS',
      userId,
      email: email ? `${email.substring(0, 3)}***` : 'unknown',
      action,
      ip
    });
  },
  
  fileUploadRejected: (filename, reason, ip) => {
    logger.warn('File upload rejected', {
      category: 'security',
      event: 'FILE_UPLOAD_REJECTED',
      filename,
      reason,
      ip
    });
  },
  
  csrfFailure: (ip, path, method) => {
    logger.warn('CSRF token validation failed', {
      category: 'security',
      event: 'CSRF_VALIDATION_FAILED',
      ip,
      path,
      method
    });
  }
};

/**
 * API Logger
 * For API requests and responses
 */
logger.api = {
  request: (method, path, ip, userId) => {
    logger.http('API request', {
      category: 'api',
      method,
      path,
      ip,
      userId
    });
  },
  
  response: (method, path, statusCode, duration) => {
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'http';
    logger.log(level, 'API response', {
      category: 'api',
      method,
      path,
      statusCode,
      duration: `${duration}ms`
    });
  },
  
  error: (method, path, error, userId) => {
    logger.error('API error', {
      category: 'api',
      method,
      path,
      error: error.message,
      stack: error.stack,
      userId
    });
  }
};

/**
 * Database Logger
 * For database operations and errors
 */
logger.database = {
  query: (operation, table, duration) => {
    logger.debug('Database query', {
      category: 'database',
      operation,
      table,
      duration: `${duration}ms`
    });
  },
  
  error: (operation, table, error) => {
    logger.error('Database error', {
      category: 'database',
      operation,
      table,
      error: error.message,
      stack: error.stack
    });
  }
};

/**
 * Performance Logger
 * For performance monitoring
 */
logger.performance = {
  slowQuery: (operation, duration, threshold = 1000) => {
    if (duration > threshold) {
      logger.warn('Slow operation detected', {
        category: 'performance',
        operation,
        duration: `${duration}ms`,
        threshold: `${threshold}ms`
      });
    }
  }
};

// Create Morgan middleware using Winston
const morganMiddleware = require('morgan');

// Custom Morgan format that uses Winston
const morganFormat = ':method :url :status :response-time ms - :res[content-length]';

const morganStream = {
  write: (message) => {
    logger.http(message.trim());
  }
};

const morganLogger = morganMiddleware(morganFormat, { stream: morganStream });

// Export logger and middleware
module.exports = {
  logger,
  morganLogger
};
