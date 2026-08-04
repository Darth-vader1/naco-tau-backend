// backend/middleware/validation.js
//
// Shared express-validator chains for common request payloads.
// Usage:
//   const { authValidationChains, studentValidationChains, validate } = require('../middleware/validation');
//   router.post('/login', authLimiter, authValidationChains.login, validate, async (req, res) => { ... });
//
// All validators here are OPTIONAL: existing routes still carry their manual
// inline checks as a defense-in-depth fallback. These chains provide cleaner
// 400 responses, reduce boilerplate, and guarantee consistent errors.

const { body, param, query, validationResult } = require('express-validator');
const { validateMatricNo } = require('../utils/validators');

/**
 * Checks the validation result and returns 400 with structured errors
 * if any rule failed. Otherwise passes to the real route handler.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const mapped = {};
  for (const err of errors.array()) {
    const field = err.param || err.path || 'unknown';
    if (!mapped[field]) mapped[field] = [];
    mapped[field].push(err.msg);
  }
  return res.status(400).json({
    success: false,
    error: 'Validation failed',
    fields: mapped,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// Auth route validators
// ============================================

const authValidationChains = {
  register: [
    body('email')
      .exists().withMessage('email is required')
      .bail()
      .isEmail().withMessage('email must be a valid address')
      .matches(/@(st\.)?tau\.edu\.ng$/i).withMessage('email must end with @tau.edu.ng or @st.tau.edu.ng')
      .normalizeEmail(),
    body('password')
      .exists().withMessage('password is required')
      .bail()
      .isLength({ min: 8 }).withMessage('password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('password must contain an uppercase letter')
      .matches(/[a-z]/).withMessage('password must contain a lowercase letter')
      .matches(/\d/).withMessage('password must contain a digit')
      .matches(/[!@#$%^&*()_+\-=\[\]{};:'",.<>/?\\|`~]/).withMessage('password must contain a special character'),
    body('firstName').exists().withMessage('firstName is required').bail()
      .isLength({ min: 2, max: 50 }).withMessage('firstName must be 2-50 characters')
      .trim().escape(),
    body('lastName').exists().withMessage('lastName is required').bail()
      .isLength({ min: 2, max: 50 }).withMessage('lastName must be 2-50 characters')
      .trim().escape(),
    body('matricNo')
      .exists().withMessage('matricNo is required').bail()
      .trim()
      .custom((value) => validateMatricNo(value))
      .withMessage('matricNo format is not valid (example: 23/10MSC014)'),
    body('department').optional()
      .isLength({ max: 100 }).withMessage('department max 100 chars').trim().escape(),
    body('phone').optional()
      .custom((v) => /^(\+234|0)[789][01]\d{8}$/.test(v.replace(/\s/g, '')))
      .withMessage('phone must be a valid Nigerian number')
  ],

  login: [
    body('email')
      .exists().withMessage('email is required').bail()
      .isEmail().withMessage('email must be valid').normalizeEmail(),
    body('password')
      .exists().withMessage('password is required').bail()
      .isLength({ min: 1 }).withMessage('password cannot be empty')
  ],

  adminLogin: [
    body('email')
      .exists().withMessage('email is required').bail()
      .isEmail().withMessage('email must be valid').normalizeEmail(),
    body('password')
      .exists().withMessage('password is required').bail()
      .isLength({ min: 1 }).withMessage('password cannot be empty')
  ],

  forgotPassword: [
    body('email')
      .exists().withMessage('email is required').bail()
      .isEmail().withMessage('email must be valid').normalizeEmail()
  ]
};

// ============================================
// Student route validators
// ============================================

const studentValidationChains = {
  updateProfile: [
    body('firstName').optional()
      .isLength({ min: 2, max: 50 }).withMessage('firstName must be 2-50 characters').trim().escape(),
    body('lastName').optional()
      .isLength({ min: 2, max: 50 }).withMessage('lastName must be 2-50 characters').trim().escape(),
    body('phone').optional()
      .custom((v) => !v || v === '' || v === null || /^(\+234|0)[789][01]\d{8}$/.test(String(v).replace(/\s/g, '')))
      .withMessage('phone must be a valid Nigerian number'),
    body('bio').optional().isLength({ max: 500 }).withMessage('bio max 500 characters').trim(),
    body('github').optional()
      .custom((v) => !v || v === null || /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_-]+\/?.*$/.test(v))
      .withMessage('github must be a github.com URL'),
    body('linkedin').optional()
      .custom((v) => !v || v === null || /^https?:\/\/(www\.)?linkedin\.com\/.+$/i.test(v))
      .withMessage('linkedin must be a linkedin.com URL'),
    // New networking fields
    body('twitter').optional()
      .custom((v) => !v || v === null || /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/.+$/i.test(v))
      .withMessage('twitter must be a twitter.com or x.com URL'),
    body('instagram').optional()
      .custom((v) => !v || v === null || /^https?:\/\/(www\.)?instagram\.com\/.+$/i.test(v))
      .withMessage('instagram must be an instagram.com URL'),
    body('portfolio_url').optional()
      .custom((v) => !v || v === null || /^https?:\/\/.+\..+/.test(v))
      .withMessage('portfolio_url must be a valid HTTP/HTTPS URL'),
    body('snapchat').optional()
      .custom((v) => !v || v === '' || v === null || (typeof v === 'string' && v.length >= 3 && v.length <= 30 && /^[a-zA-Z0-9._-]+$/.test(v)))
      .withMessage('snapchat username must be 3-30 characters (letters, numbers, dots, underscores, hyphens only)')
      .trim(),
    body('skills').optional().isArray({ max: 20 }).withMessage('skills must be an array (max 20 items)'),
    body('skills.*').optional().isLength({ min: 1, max: 50 }).withMessage('each skill must be 1-50 characters').trim(),
    body('interests').optional().isArray({ max: 10 }).withMessage('interests must be an array (max 10 items)'),
    body('interests.*').optional().isLength({ min: 1, max: 50 }).withMessage('each interest must be 1-50 characters').trim(),
    body('year_of_study').optional()
      .isIn([100, 200, 300, 400, 500]).withMessage('year_of_study must be one of: 100, 200, 300, 400, 500'),
    body('graduation_year').optional()
      .isInt({ min: new Date().getFullYear(), max: new Date().getFullYear() + 10 })
      .withMessage(`graduation_year must be between ${new Date().getFullYear()} and ${new Date().getFullYear() + 10}`),
    body('visibility').optional()
      .isIn(['public', 'students-only', 'private']).withMessage('visibility must be one of: public, students-only, private'),
    body('privacy_settings').optional()
      .isObject().withMessage('privacy_settings must be an object'),
    body('privacy_settings.show_email').optional()
      .isBoolean().withMessage('show_email must be a boolean'),
    body('privacy_settings.show_phone').optional()
      .isBoolean().withMessage('show_phone must be a boolean'),
    body('privacy_settings.show_matric').optional()
      .isBoolean().withMessage('show_matric must be a boolean')
  ],

  adminBulkStatus: [
    param('id').isUUID(4).withMessage('student id must be a valid UUID'),
    body('status').isIn(['pending', 'active', 'rejected', 'banned'])
      .withMessage('status must be one of: pending, active, rejected, banned'),
    body('reason').optional().isLength({ max: 500 }).trim().escape()
  ],

  listQuery: [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be an int >= 1').toInt(),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('limit must be 1-1000').toInt(),
    query('status').optional()
      .isIn(['pending', 'active', 'rejected', 'banned', 'all']).withMessage('status filter not valid'),
    query('search').optional().isLength({ max: 100 }).trim().escape()
  ],

  // New: Directory query validation
  directoryQuery: [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be an int >= 1').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1-100').toInt(),
    query('search').optional().isLength({ max: 100 }).withMessage('search max 100 chars').trim(),
    query('department').optional().isLength({ max: 100 }).withMessage('department max 100 chars').trim(),
    query('skills').optional().isLength({ max: 200 }).withMessage('skills max 200 chars').trim(),
    query('interests').optional().isLength({ max: 200 }).withMessage('interests max 200 chars').trim(),
    query('year').optional().isInt({ min: 100, max: 500 }).withMessage('year must be 100-500').toInt(),
    query('sort').optional()
      .isIn(['name-asc', 'name-desc', 'recent']).withMessage('sort must be one of: name-asc, name-desc, recent')
  ]
};

// ============================================
// Generic helpers (exported for other route modules to build their own chains)
// ============================================

const idParam = (name = 'id') => [
  param(name).isUUID(4).withMessage(`${name} must be a valid UUID`)
];

const paginationQuery = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be an int >= 1').toInt(),
  query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('limit must be 1-1000').toInt(),
  query('search').optional().isLength({ max: 100 }).trim().escape()
];

module.exports = {
  validate,
  authValidationChains,
  studentValidationChains,
  idParam,
  paginationQuery
};
