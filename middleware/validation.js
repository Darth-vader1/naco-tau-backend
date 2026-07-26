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

/**
 * Checks the validation result and returns 400 with structured errors
 * if any rule failed. Otherwise passes to the real route handler.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const mapped = {};
  for (const err of errors.array()) {
    if (!mapped[err.param]) mapped[err.param] = [];
    mapped[err.param].push(err.msg);
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
      .custom((value) => /^TAU\/[A-Z]{2,4}\/\d{2,4}\/\d{3,4}$/i.test(value) ||
                             /^\d{2}\/\d{2}[A-Z]{2,4}\d{3,4}$/i.test(value))
      .withMessage('matricNo format is not valid (examples: TAU/CS/20/001, 23/10MSC014)'),
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
      .custom((v) => v === '' || /^(\+234|0)[789][01]\d{8}$/.test(String(v).replace(/\s/g, '')))
      .withMessage('phone must be a valid Nigerian number'),
    body('bio').optional().isLength({ max: 2000 }).withMessage('bio max 2000 characters').trim().escape(),
    body('github').optional()
      .custom((v) => v === '' || /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_-]+\/?.*$/.test(v))
      .withMessage('github must be a github.com URL'),
    body('linkedin').optional()
      .custom((v) => v === '' || /^https?:\/\/(www\.)?linkedin\.com\/.+$/i.test(v))
      .withMessage('linkedin must be a linkedin.com URL'),
    body('skills').optional().isArray({ max: 50 }).withMessage('skills must be an array (<=50)'),
    body('skills.*').optional().isLength({ max: 60 }).trim().escape()
  ],

  adminBulkStatus: [
    param('id').isUUID(4).withMessage('student id must be a valid UUID'),
    body('status').isIn(['pending', 'active', 'rejected', 'banned'])
      .withMessage('status must be one of: pending, active, rejected, banned'),
    body('reason').optional().isLength({ max: 500 }).trim().escape()
  ],

  listQuery: [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be an int >= 1').toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1-200').toInt(),
    query('status').optional()
      .isIn(['pending', 'active', 'rejected', 'banned']).withMessage('status filter not valid'),
    query('search').optional().isLength({ max: 100 }).trim().escape()
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
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1-200').toInt(),
  query('search').optional().isLength({ max: 100 }).trim().escape()
];

module.exports = {
  validate,
  authValidationChains,
  studentValidationChains,
  idParam,
  paginationQuery
};
