// backend/utils/validators.js
const validator = require('validator');

// ============================================
// EMAIL VALIDATION
// ============================================

/**
 * Validate TAU student email format
 * Supports: @st.tau.edu.ng and @tau.edu.ng
 */
const validateEmail = (email) => {
    if (!email) return false;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(st\.)?tau\.edu\.ng$/;
    return emailRegex.test(email.toLowerCase().trim());
};

/**
 * Validate any email format
 */
const validateGeneralEmail = (email) => {
    if (!email) return false;
    return validator.isEmail(email);
};

// ============================================
// PASSWORD VALIDATION
// ============================================

/**
 * Validate password strength
 * Requirements:
 * - At least 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */
const validatePassword = (password) => {
    if (!password || password.length < 8) return false;
    
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};:'",.<>/?\\|`~]/.test(password);
    
    return hasUpperCase && hasLowerCase && hasNumber && hasSpecialChar;
};

/**
 * Get password strength score
 * Returns: { score: 0-4, label: 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong' }
 */
const getPasswordStrength = (password) => {
    if (!password) return { score: 0, label: 'Weak' };
    
    let score = 0;
    
    // Length
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    
    // Complexity
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[!@#$%^&*()_+\-=\[\]{};:'",.<>/?\\|`~]/.test(password)) score++;
    
    // Normalize score to 0-4
    score = Math.min(Math.floor(score / 2), 4);
    
    const labels = ['Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
    
    return {
        score,
        label: labels[score] || 'Weak'
    };
};

// ============================================
// MATRIC NUMBER VALIDATION
// ============================================

/**
 * Validate TAU matric number format
 * Accepted format: YY/NNDDD###
 *   YY  -> 2-digit intake year
 *   NN  -> 2-digit faculty/programme numeric code
 *   DDD -> 2-4 letter departmental code
 *   ### -> 3-4 digit serial number
 * Example: 23/10MSC014
 */
const validateMatricNo = (matricNo) => {
    if (!matricNo) return false;
    const pattern = /^\d{2}\/\d{2}[A-Z]{2,4}\d{3,4}$/i;
    const trimmed = matricNo.trim().toUpperCase();
    return pattern.test(trimmed);
};

/**
 * Extract departmental code from matric number.
 * Format: YY/NNDDD###  →  DDD letters (between 2-digit NN block and trailing ### digits)
 * Example: 23/10MSC014  →  MSC
 */
const extractDepartmentFromMatric = (matricNo) => {
    if (!matricNo) return null;
    const match = matricNo.trim().toUpperCase().match(/^\d{2}\/\d{2}([A-Z]{2,4})\d{3,4}$/);
    return match ? match[1] : null;
};

/**
 * Extract intake year from matric number.
 * Format: YY/NNDDD###  →  YY (converted to 20YY)
 * Example: 23/10MSC014  →  2023
 */
const extractYearFromMatric = (matricNo) => {
    if (!matricNo) return null;
    const match = matricNo.trim().toUpperCase().match(/^(\d{2})\/\d{2}[A-Z]{2,4}\d{3,4}$/);
    if (!match) return null;
    const yy = parseInt(match[1], 10);
    return isNaN(yy) ? null : 2000 + yy;
};

// ============================================
// PHONE NUMBER VALIDATION
// ============================================

/**
 * Validate Nigerian phone number
 */
const validatePhoneNumber = (phone) => {
    if (!phone) return false;
    const phoneRegex = /^(0|\+234)?[789][01]\d{8}$/;
    return phoneRegex.test(phone.replace(/\s/g, ''));
};

/**
 * Format phone number to Nigerian format
 */
const formatPhoneNumber = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/\s/g, '');
    
    // If starts with 0, add +234
    if (cleaned.startsWith('0')) {
        cleaned = '+234' + cleaned.substring(1);
    }
    // If doesn't start with +, add +234
    else if (!cleaned.startsWith('+')) {
        cleaned = '+234' + cleaned;
    }
    
    return cleaned;
};

// ============================================
// NAME VALIDATION
// ============================================

/**
 * Validate name (only letters, spaces, hyphens, apostrophes)
 */
const validateName = (name) => {
    if (!name) return false;
    const nameRegex = /^[a-zA-Z\s\-']{2,50}$/;
    return nameRegex.test(name.trim());
};

/**
 * Capitalize name properly
 */
const capitalizeName = (name) => {
    if (!name) return '';
    return name.trim()
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};

// ============================================
// URL VALIDATION
// ============================================

/**
 * Validate URL
 */
const validateUrl = (url) => {
    if (!url) return true; // Optional field
    return validator.isURL(url, {
        protocols: ['http', 'https'],
        require_protocol: true
    });
};

/**
 * Validate image URL
 */
const validateImageUrl = (url) => {
    if (!url) return true;
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;
    return validator.isURL(url) && imageExtensions.test(url);
};

/**
 * Extract file extension from URL
 */
const getFileExtension = (url) => {
    if (!url) return null;
    const parts = url.split('.');
    return parts[parts.length - 1].toLowerCase();
};

// ============================================
// DATE VALIDATION
// ============================================

/**
 * Validate date (YYYY-MM-DD)
 */
const validateDate = (date) => {
    if (!date) return false;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) return false;
    
    const d = new Date(date);
    return d instanceof Date && !isNaN(d);
};

/**
 * Validate future date
 */
const validateFutureDate = (date) => {
    if (!validateDate(date)) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate >= today;
};

/**
 * Validate past date
 */
const validatePastDate = (date) => {
    if (!validateDate(date)) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate <= today;
};

/**
 * Format date to readable format
 */
const formatDate = (date, format = 'DD/MM/YYYY') => {
    if (!date) return 'N/A';
    const d = new Date(date);
    if (isNaN(d)) return 'Invalid Date';
    
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    
    switch (format) {
        case 'DD/MM/YYYY':
            return `${day}/${month}/${year}`;
        case 'MM/DD/YYYY':
            return `${month}/${day}/${year}`;
        case 'YYYY-MM-DD':
            return `${year}-${month}-${day}`;
        case 'DD MMM YYYY':
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return `${day} ${months[d.getMonth()]} ${year}`;
        case 'full':
            return d.toLocaleDateString('en-NG', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        default:
            return `${day}/${month}/${year}`;
    }
};

// ============================================
// FILE VALIDATION
// ============================================

/**
 * Validate file type
 */
const validateFileType = (filename, allowedTypes) => {
    if (!filename) return false;
    const extension = filename.split('.').pop().toLowerCase();
    return allowedTypes.includes(extension);
};

/**
 * Get allowed file types
 */
const getFileTypes = () => ({
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
    document: ['pdf', 'doc', 'docx', 'txt', 'rtf'],
    presentation: ['ppt', 'pptx', 'key'],
    spreadsheet: ['xls', 'xlsx', 'csv'],
    archive: ['zip', 'rar', '7z'],
    video: ['mp4', 'avi', 'mov', 'wmv'],
    audio: ['mp3', 'wav', 'aac', 'ogg']
});

/**
 * Get file size in human readable format
 */
const getReadableFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// ============================================
// OBJECT VALIDATION
// ============================================

/**
 * Check if object is empty
 */
const isEmptyObject = (obj) => {
    return obj && typeof obj === 'object' && Object.keys(obj).length === 0;
};

/**
 * Check if object has required fields
 */
const hasRequiredFields = (obj, requiredFields) => {
    if (!obj || typeof obj !== 'object') return false;
    return requiredFields.every(field => {
        const value = obj[field];
        return value !== undefined && value !== null && value !== '';
    });
};

/**
 * Sanitize object (remove undefined/null values)
 */
const sanitizeObject = (obj) => {
    if (!obj || typeof obj !== 'object') return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') {
            sanitized[key] = value;
        }
    }
    return sanitized;
};

// ============================================
// INPUT SANITIZATION
// ============================================

/**
 * Sanitize string input (prevent XSS) — escapes HTML entities
 */
const sanitizeInput = (input) => {
    if (!input) return '';
    if (typeof input !== 'string') return input;
    return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
};

/**
 * Sanitize array of strings
 */
const sanitizeArray = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => 
        typeof item === 'string' ? sanitizeInput(item) :
        Array.isArray(item) ? sanitizeArray(item) :
        (item && typeof item === 'object') ? sanitizeDeep(item) : item
    );
};

/**
 * Deeply sanitize an object: all string values → sanitizeInput,
 * arrays → sanitizeArray, nested objects are recursed.
 * Fields that contain structured identifiers, URLs, or secrets are left
 * untouched:
 *   - Sensitive values (password, token, secret, proof) are used verbatim.
 *   - Structured codes with delimiters (matricNo, departmental codes, etc.)
 *     must preserve `/` and similar characters for downstream regex validation.
 *   - URL-bearing fields are validated separately by their route validators.
 */
const sanitizeDeep = (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return sanitizeInput(value);
    if (Array.isArray(value)) return sanitizeArray(value);
    if (typeof value !== 'object') return value;

    const sensitiveKeys = /password|secret|token|proof|manifesto|roadmap|details|matric|phone|url|linkedin|github|website|avatar|image|photo|picture|logo|banner|attachment|file|document|cv|resume|portfolio/i;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = sensitiveKeys.test(k)
            ? v
            : sanitizeDeep(v);
    }
    return out;
};

/**
 * Express middleware: sanitize req.body, req.query, and req.params for all
 * non-trivial text payloads. Runs AFTER body parsing but BEFORE routes.
 * Skips binary upload payloads (Buffer), and sensitive fields (passwords, tokens).
 */
const sanitizeRequestBody = (req, res, next) => {
    try {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
            req.body = sanitizeDeep(req.body);
        }
        if (req.query && typeof req.query === 'object') {
            req.query = sanitizeDeep(req.query);
        }
        if (req.params && typeof req.params === 'object') {
            req.params = sanitizeDeep(req.params);
        }
    } catch (err) {
        console.error('[sanitizeRequestBody] failed:', err.message);
    }
    next();
};

// ============================================
// ROLE VALIDATION
// ============================================

/**
 * Validate user role
 */
const validateRole = (role) => {
    const validRoles = ['student', 'admin', 'super_admin'];
    return validRoles.includes(role);
};

/**
 * Check if user has permission
 */
const hasPermission = (userRole, requiredRole) => {
    const roleHierarchy = {
        'student': 0,
        'admin': 1,
        'super_admin': 2
    };
    
    const userLevel = roleHierarchy[userRole] || 0;
    const requiredLevel = roleHierarchy[requiredRole] || 0;
    
    return userLevel >= requiredLevel;
};

// ============================================
// STATUS VALIDATION
// ============================================

/**
 * Validate student status
 */
const validateStudentStatus = (status) => {
    const validStatuses = ['pending', 'active', 'rejected', 'banned'];
    return validStatuses.includes(status);
};

/**
 * Validate payment status
 */
const validatePaymentStatus = (status) => {
    const validStatuses = ['pending', 'verified', 'rejected'];
    return validStatuses.includes(status);
};

/**
 * Validate event registration status
 */
const validateEventStatus = (status) => {
    const validStatuses = ['registered', 'attended', 'cancelled'];
    return validStatuses.includes(status);
};

// ============================================
// EXPORT ALL VALIDATORS
// ============================================

module.exports = {
    // Email
    validateEmail,
    validateGeneralEmail,
    
    // Password
    validatePassword,
    getPasswordStrength,
    
    // Matric
    validateMatricNo,
    extractDepartmentFromMatric,
    extractYearFromMatric,
    
    // Phone
    validatePhoneNumber,
    formatPhoneNumber,
    
    // Name
    validateName,
    capitalizeName,
    
    // URL
    validateUrl,
    validateImageUrl,
    getFileExtension,
    
    // Date
    validateDate,
    validateFutureDate,
    validatePastDate,
    formatDate,
    
    // File
    validateFileType,
    getFileTypes,
    getReadableFileSize,
    
    // Object
    isEmptyObject,
    hasRequiredFields,
    sanitizeObject,
    
    // Input
    sanitizeInput,
    sanitizeArray,
    sanitizeDeep,
    sanitizeRequestBody,
    
    // Role
    validateRole,
    hasPermission,
    
    // Status
    validateStudentStatus,
    validatePaymentStatus,
    validateEventStatus
};