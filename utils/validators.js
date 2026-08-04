// utils/validators.js

/**
 * Validation utilities for student networking features
 */

// URL validation regex (basic HTTP/HTTPS)
const urlRegex = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/;

/**
 * Validate a URL format
 * @param {string} url - URL to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateUrl(url) {
  if (!url) return true; // Optional field
  return urlRegex.test(url);
}

/**
 * Validate social media URL with platform-specific patterns
 * @param {string} url - URL to validate
 * @param {string} platform - Platform name (linkedin, github, twitter, instagram)
 * @returns {boolean} - True if valid, false otherwise
 */
function validateSocialUrl(url, platform) {
  if (!url) return true; // Optional field
  if (!urlRegex.test(url)) return false;
  
  // Platform-specific validation
  const patterns = {
    linkedin: /linkedin\.com\/(in|company)\//,
    github: /github\.com\//,
    twitter: /(twitter\.com|x\.com)\//,
    instagram: /instagram\.com\//
  };
  
  return patterns[platform] ? patterns[platform].test(url) : true;
}

/**
 * Validate an array of strings
 * @param {Array} arr - Array to validate
 * @param {number} maxItems - Maximum number of items allowed
 * @param {number} maxLength - Maximum length of each item
 * @returns {boolean} - True if valid, false otherwise
 */
function validateArray(arr, maxItems = 20, maxLength = 50) {
  if (!arr) return true; // Optional field
  if (!Array.isArray(arr)) return false;
  if (arr.length > maxItems) return false;
  
  return arr.every(item => 
    typeof item === 'string' && 
    item.trim().length > 0 &&
    item.length <= maxLength
  );
}

/**
 * Validate skills array
 * @param {Array} skills - Skills array to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateSkills(skills) {
  return validateArray(skills, 20, 50);
}

/**
 * Validate interests array
 * @param {Array} interests - Interests array to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateInterests(interests) {
  return validateArray(interests, 10, 50);
}

/**
 * Validate bio text
 * @param {string} bio - Bio text to validate
 * @param {number} maxLength - Maximum length allowed
 * @returns {boolean} - True if valid, false otherwise
 */
function validateBio(bio, maxLength = 500) {
  if (!bio) return true; // Optional field
  return typeof bio === 'string' && bio.length <= maxLength;
}

/**
 * Validate year of study
 * @param {number} year - Year to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateYearOfStudy(year) {
  if (!year) return true; // Optional field
  return Number.isInteger(year) && [100, 200, 300, 400, 500].includes(year);
}

/**
 * Validate graduation year
 * @param {number} year - Year to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateGraduationYear(year) {
  if (!year) return true; // Optional field
  const currentYear = new Date().getFullYear();
  const maxYear = currentYear + 10;
  return Number.isInteger(year) && year >= currentYear && year <= maxYear;
}

/**
 * Validate visibility setting
 * @param {string} visibility - Visibility setting to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateVisibility(visibility) {
  if (!visibility) return true; // Optional field (will use default)
  return ['public', 'students-only', 'private'].includes(visibility);
}

/**
 * Validate privacy settings object
 * @param {Object} settings - Privacy settings object to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validatePrivacySettings(settings) {
  if (!settings) return true; // Optional field (will use default)
  if (typeof settings !== 'object') return false;
  
  const allowedKeys = ['show_email', 'show_phone', 'show_matric'];
  const keys = Object.keys(settings);
  
  // Check all keys are allowed
  if (!keys.every(key => allowedKeys.includes(key))) return false;
  
  // Check all values are booleans
  return keys.every(key => typeof settings[key] === 'boolean');
}

/**
 * Sanitize bio text (remove HTML tags, trim)
 * @param {string} bio - Bio text to sanitize
 * @returns {string} - Sanitized bio
 */
function sanitizeBio(bio) {
  if (!bio) return '';
  
  // Remove HTML tags
  let sanitized = bio.replace(/<[^>]*>/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500);
  }
  
  return sanitized;
}

/**
 * Sanitize array items (trim, remove empty)
 * @param {Array} arr - Array to sanitize
 * @returns {Array} - Sanitized array
 */
function sanitizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  
  return arr
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(item => item.length > 0);
}

/**
 * Apply privacy settings to profile data
 * @param {Object} profile - Profile object
 * @param {Object} privacySettings - Privacy settings object
 * @param {boolean} isOwnProfile - Whether this is the user's own profile
 * @returns {Object} - Filtered profile object
 */
function applyPrivacySettings(profile, privacySettings, isOwnProfile = false) {
  // If it's the user's own profile, return everything
  if (isOwnProfile) return profile;
  
  const filtered = { ...profile };
  const settings = privacySettings || {
    show_email: false,
    show_phone: false,
    show_matric: false
  };
  
  // Remove fields based on privacy settings
  if (!settings.show_email) {
    delete filtered.email;
  }
  
  if (!settings.show_phone) {
    delete filtered.phone;
  }
  
  if (!settings.show_matric) {
    delete filtered.matric_no;
  }
  
  return filtered;
}

/**
 * Middleware to sanitize request body to prevent XSS attacks
 * Escapes HTML entities in all string fields except URLs and specific fields
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function sanitizeRequestBody(req, res, next) {
  // Fields that should not be sanitized (URLs, etc.)
  const skipFields = [
    'github', 'linkedin', 'twitter', 'instagram', 'portfolio_url', 'snapchat',
    'password', 'token', 'access_token', 'refresh_token',
    'proof_url', 'file_url', 'image_url', 'profile_picture_url'
  ];
  
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body, skipFields);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query, skipFields);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeObject(req.params, skipFields);
  }
  next();
}

/**
 * Recursively sanitize an object
 * @param {Object} obj - Object to sanitize
 * @param {Array} skipFields - Fields to skip sanitization
 * @param {string} parentKey - Parent key for nested objects
 * @returns {Object} - Sanitized object
 */
function sanitizeObject(obj, skipFields = [], parentKey = '') {
  const sanitized = {};
  
  for (const key in obj) {
    const value = obj[key];
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    
    // Skip fields that shouldn't be sanitized
    if (skipFields.includes(key) || skipFields.includes(fullKey)) {
      sanitized[key] = value;
      continue;
    }
    
    if (typeof value === 'string') {
      // Escape HTML entities
      sanitized[key] = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item, index) => {
        if (typeof item === 'string') {
          return item
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
        }
        if (item && typeof item === 'object') {
          return sanitizeObject(item, skipFields, `${fullKey}[${index}]`);
        }
        return item;
      });
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeObject(value, skipFields, fullKey);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

module.exports = {
  validateUrl,
  validateSocialUrl,
  validateArray,
  validateSkills,
  validateInterests,
  validateBio,
  validateYearOfStudy,
  validateGraduationYear,
  validateVisibility,
  validatePrivacySettings,
  sanitizeBio,
  sanitizeArray,
  applyPrivacySettings,
  sanitizeRequestBody
};
