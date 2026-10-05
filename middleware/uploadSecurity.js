// middleware/uploadSecurity.js
// Enhanced file upload security layer
// Works alongside existing upload.js middleware

const { logger } = require('../config/logger');

// Note: file-type requires ES modules, so we'll use a simpler approach
// that doesn't require dynamic imports

/**
 * Malware/malicious content scanner
 * Scans file buffer for common attack patterns
 */
function scanForMaliciousContent(buffer, filename, ip) {
  const checks = [];
  
  // Convert buffer to string for text-based checks (first 2KB)
  const textContent = buffer.toString('utf8', 0, Math.min(buffer.length, 2048));
  
  // Check 1: PHP code
  if (textContent.includes('<?php') || textContent.includes('<?=') || textContent.includes('<?')) {
    checks.push({ passed: false, reason: 'PHP code detected' });
  }
  
  // Check 2: JavaScript in non-JS/HTML files
  const allowsScript = filename.endsWith('.js') || filename.endsWith('.html') || filename.endsWith('.htm');
  if (!allowsScript) {
    if (textContent.includes('<script') || textContent.includes('javascript:') || textContent.includes('onerror=')) {
      checks.push({ passed: false, reason: 'JavaScript code detected in non-script file' });
    }
  }
  
  // Check 3: SQL injection attempts in filenames or content
  const sqlPatterns = ['DROP TABLE', 'DELETE FROM', 'INSERT INTO', 'UPDATE SET', '--', '/*', '*/'];
  for (const pattern of sqlPatterns) {
    if (filename.toUpperCase().includes(pattern) || textContent.toUpperCase().includes(pattern)) {
      checks.push({ passed: false, reason: `SQL pattern detected: ${pattern}` });
      break;
    }
  }
  
  // Check 4: Executable signatures
  const executableSignatures = [
    { hex: '4D5A', name: 'Windows PE executable (MZ)' },
    { hex: '7F454C46', name: 'Linux ELF executable' },
    { hex: 'CAFEBABE', name: 'Java class file' },
    { hex: '504B0304', name: 'ZIP/JAR archive', warning: true } // Warning only for ZIPs
  ];
  
  for (const sig of executableSignatures) {
    const sigBuffer = Buffer.from(sig.hex, 'hex');
    if (buffer.slice(0, sigBuffer.length).equals(sigBuffer)) {
      if (!sig.warning) {
        checks.push({ passed: false, reason: `${sig.name} detected` });
      }
      break;
    }
  }
  
  // Check 5: Shell commands
  const shellPatterns = ['#!/bin/bash', '#!/bin/sh', 'eval(', 'exec(', 'system(', 'passthru('];
  for (const pattern of shellPatterns) {
    if (textContent.includes(pattern)) {
      checks.push({ passed: false, reason: `Shell command pattern detected: ${pattern}` });
      break;
    }
  }
  
  // Check 6: Suspicious extensions in filename
  const suspiciousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.jar', '.class'];
  const hassSuspiciousExt = suspiciousExtensions.some(ext => filename.toLowerCase().endsWith(ext));
  if (hasSuspiciousExt) {
    checks.push({ passed: false, reason: 'Suspicious file extension' });
  }
  
  // Return results
  const failed = checks.filter(c => !c.passed);
  if (failed.length > 0) {
    logger.security.fileUploadRejected(filename, failed.map(f => f.reason).join(', '), ip);
    return {
      safe: false,
      reasons: failed.map(f => f.reason)
    };
  }
  
  return { safe: true, reasons: [] };
}

/**
 * Sanitize filename
 * Removes path traversal and dangerous characters
 */
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed';
  
  // Remove path traversal
  let sanitized = filename.replace(/\.\./g, '').replace(/\//g, '_').replace(/\\/g, '_');
  
  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');
  
  // Replace potentially dangerous characters
  sanitized = sanitized.replace(/[<>:"|?*]/g, '_');
  
  // Remove leading/trailing dots and spaces
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');
  
  // Ensure it's not empty after sanitization
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'file';
  }
  
  // Limit length (keep extension)
  const maxLength = 200;
  if (sanitized.length > maxLength) {
    const parts = sanitized.split('.');
    const ext = parts.length > 1 ? '.' + parts.pop() : '';
    const base = parts.join('.');
    sanitized = base.substring(0, maxLength - ext.length) + ext;
  }
  
  return sanitized;
}

/**
 * Validate file size per context
 */
const SIZE_LIMITS = {
  'profile-pictures': 5 * 1024 * 1024, // 5MB
  'payment-proofs': 2 * 1024 * 1024, // 2MB
  'past-questions': 50 * 1024 * 1024, // 50MB
  'resources': 100 * 1024 * 1024, // 100MB
  'timetables': 10 * 1024 * 1024, // 10MB
  'event-images': 10 * 1024 * 1024, // 10MB
  'voting-photos': 5 * 1024 * 1024, // 5MB
  'default': 10 * 1024 * 1024 // 10MB
};

function validateFileSize(file, bucket) {
  const limit = SIZE_LIMITS[bucket] || SIZE_LIMITS.default;
  return file.size <= limit;
}

/**
 * Security scanning middleware
 * Should be used AFTER multer upload but BEFORE Supabase upload
 */
function securityScanMiddleware(req, res, next) {
  try {
    // Check single file
    if (req.file) {
      const scan = scanForMaliciousContent(req.file.buffer, req.file.originalname, req.ip);
      if (!scan.safe) {
        return res.status(400).json({
          success: false,
          error: 'File upload rejected for security reasons',
          details: scan.reasons.join('; ')
        });
      }
      
      // Sanitize filename
      req.file.originalname = sanitizeFilename(req.file.originalname);
      
      // Check size against bucket-specific limits
      if (req.resolvedBucket && !validateFileSize(req.file, req.resolvedBucket)) {
        const limit = SIZE_LIMITS[req.resolvedBucket] || SIZE_LIMITS.default;
        return res.status(413).json({
          success: false,
          error: `File exceeds size limit for ${req.resolvedBucket}`,
          limit: `${Math.round(limit / 1024 / 1024)}MB`
        });
      }
    }
    
    // Check multiple files
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        const scan = scanForMaliciousContent(file.buffer, file.originalname, req.ip);
        if (!scan.safe) {
          return res.status(400).json({
            success: false,
            error: `File "${file.originalname}" rejected for security reasons`,
            details: scan.reasons.join('; ')
          });
        }
        
        // Sanitize filename
        file.originalname = sanitizeFilename(file.originalname);
        
        // Check size
        if (req.resolvedBucket && !validateFileSize(file, req.resolvedBucket)) {
          const limit = SIZE_LIMITS[req.resolvedBucket] || SIZE_LIMITS.default;
          return res.status(413).json({
            success: false,
            error: `File "${file.originalname}" exceeds size limit`,
            limit: `${Math.round(limit / 1024 / 1024)}MB`
          });
        }
      }
    }
    
    next();
  } catch (error) {
    logger.error('Security scan middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'File security scan failed'
    });
  }
}

/**
 * Honeypot file upload endpoint
 * Detects automated scanners and bots
 */
function createHoneypotUpload() {
  return (req, res) => {
    logger.security.suspiciousActivity('HONEYPOT_TRIGGERED', {
      ip: req.ip,
      path: req.path,
      method: req.method,
      userAgent: req.get('user-agent'),
      body: req.body
    });
    
    // Return fake success to fool the attacker
    res.json({
      success: true,
      message: 'File uploaded successfully',
      url: 'https://example.com/fake-file.jpg'
    });
  };
}

module.exports = {
  securityScanMiddleware,
  scanForMaliciousContent,
  sanitizeFilename,
  validateFileSize,
  SIZE_LIMITS,
  createHoneypotUpload
};
