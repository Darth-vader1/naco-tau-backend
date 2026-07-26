// backend/utils/helpers.js
const crypto = require('crypto');

// ============================================
// RESPONSE HELPERS
// ============================================

/**
 * Standard API success response
 */
const successResponse = (res, data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        timestamp: new Date().toISOString()
    });
};

/**
 * Standard API error response
 */
const errorResponse = (res, message = 'Error occurred', statusCode = 500, details = null) => {
    const response = {
        success: false,
        error: message,
        timestamp: new Date().toISOString()
    };
    
    if (details && process.env.NODE_ENV !== 'production') {
        response.details = details;
    }
    
    return res.status(statusCode).json(response);
};

// ============================================
// ID GENERATORS
// ============================================

/**
 * Generate a unique ID
 */
const generateId = (prefix = '') => {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    const id = `${timestamp}${random}`;
    return prefix ? `${prefix}_${id}` : id;
};

/**
 * Generate a transaction ID
 */
const generateTransactionId = () => {
    const prefix = 'NACOS';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
};

/**
 * Generate a random password
 */
const generateRandomPassword = (length = 12) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

/**
 * Generate a random OTP (One-Time Password)
 */
const generateOTP = (length = 6) => {
    const digits = '0123456789';
    let otp = '';
    for (let i = 0; i < length; i++) {
        otp += digits.charAt(Math.floor(Math.random() * digits.length));
    }
    return otp;
};

// ============================================
// STRING HELPERS
// ============================================

/**
 * Truncate text with ellipsis
 */
const truncateText = (text, maxLength = 100) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
};

/**
 * Slugify a string
 */
const slugify = (text) => {
    if (!text) return '';
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
};

/**
 * Extract initials from name
 */
const getInitials = (name) => {
    if (!name) return '';
    const parts = name.trim().split(' ');
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

// ============================================
// ARRAY HELPERS
// ============================================

/**
 * Paginate array
 */
const paginateArray = (array, page = 1, limit = 20) => {
    const start = (page - 1) * limit;
    const end = page * limit;
    const items = array.slice(start, end);
    
    return {
        items,
        pagination: {
            page,
            limit,
            total: array.length,
            pages: Math.ceil(array.length / limit)
        }
    };
};

/**
 * Group array by key
 */
const groupBy = (array, key) => {
    if (!array || !Array.isArray(array)) return {};
    return array.reduce((result, item) => {
        const groupKey = item[key];
        if (!result[groupKey]) {
            result[groupKey] = [];
        }
        result[groupKey].push(item);
        return result;
    }, {});
};

/**
 * Unique array by key
 */
const uniqueBy = (array, key) => {
    if (!array || !Array.isArray(array)) return [];
    const seen = new Set();
    return array.filter(item => {
        const value = item[key];
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
    });
};

// ============================================
// DATE HELPERS
// ============================================

/**
 * Get relative time (e.g., "2 hours ago")
 */
const getRelativeTime = (date) => {
    const now = new Date();
    const diff = now - new Date(date);
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);
    
    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (weeks < 4) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`;
    return `${years} year${years > 1 ? 's' : ''} ago`;
};

/**
 * Get academic session based on current date
 */
const getAcademicSession = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-11
    
    // If month is Jan-June (0-5), session is previous year / current year
    if (month < 6) {
        return `${year - 1}/${year}`;
    }
    // If month is July-Dec (6-11), session is current year / next year
    return `${year}/${year + 1}`;
};

/**
 * Get current semester
 */
const getCurrentSemester = () => {
    const month = new Date().getMonth(); // 0-11
    
    // First semester: Sept-Dec (8-11)
    if (month >= 8 && month <= 11) return '1';
    // Second semester: Jan-Aug (0-7)
    return '2';
};

// ============================================
// OBJECT HELPERS
// ============================================

/**
 * Pick specific fields from object
 */
const pick = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return {};
    return keys.reduce((result, key) => {
        if (obj[key] !== undefined) {
            result[key] = obj[key];
        }
        return result;
    }, {});
};

/**
 * Omit specific fields from object
 */
const omit = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return {};
    const result = { ...obj };
    keys.forEach(key => delete result[key]);
    return result;
};

/**
 * Deep clone object
 */
const deepClone = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    return JSON.parse(JSON.stringify(obj));
};

/**
 * Merge objects deeply
 */
const deepMerge = (target, source) => {
    if (!target || typeof target !== 'object') return source;
    if (!source || typeof source !== 'object') return target;
    
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
};

// ============================================
// ENVIRONMENT HELPERS
// ============================================

/**
 * Check if running in development
 */
const isDevelopment = () => {
    return process.env.NODE_ENV === 'development';
};

/**
 * Check if running in production
 */
const isProduction = () => {
    return process.env.NODE_ENV === 'production';
};

/**
 * Check if running in test
 */
const isTest = () => {
    return process.env.NODE_ENV === 'test';
};

/**
 * Get environment variable with fallback
 */
const getEnv = (key, fallback = null) => {
    return process.env[key] || fallback;
};

// ============================================
// MISC HELPERS
// ============================================

/**
 * Sleep/delay for a specified time
 */
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Retry a function with exponential backoff
 */
const retry = async (fn, maxRetries = 3, delay = 1000) => {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (i < maxRetries - 1) {
                await sleep(delay * Math.pow(2, i));
            }
        }
    }
    throw lastError;
};

/**
 * Validate and parse JSON safely
 */
const safeJSONParse = (jsonString, fallback = null) => {
    try {
        return JSON.parse(jsonString);
    } catch {
        return fallback;
    }
};

/**
 * Create a hash from string
 */
const createHash = (string, algorithm = 'sha256') => {
    return crypto.createHash(algorithm).update(string).digest('hex');
};

// ============================================
// EXPORT ALL HELPERS
// ============================================

module.exports = {
    // Response
    successResponse,
    errorResponse,
    
    // ID Generators
    generateId,
    generateTransactionId,
    generateRandomPassword,
    generateOTP,
    
    // String
    truncateText,
    slugify,
    getInitials,
    
    // Array
    paginateArray,
    groupBy,
    uniqueBy,
    
    // Date
    getRelativeTime,
    getAcademicSession,
    getCurrentSemester,
    
    // Object
    pick,
    omit,
    deepClone,
    deepMerge,
    
    // Environment
    isDevelopment,
    isProduction,
    isTest,
    getEnv,
    
    // Misc
    sleep,
    retry,
    safeJSONParse,
    createHash
};