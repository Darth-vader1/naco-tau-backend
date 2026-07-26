// backend/middleware/upload.js
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { validateFileType, getReadableFileSize } = require('../utils/validators');

// ============================================
// MULTER CONFIGURATION
// ============================================

// Memory storage (files stored in memory before upload to Supabase)
const storage = multer.memoryStorage();

// File filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = {
        'image': ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
        'document': ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
        'presentation': ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
        'spreadsheet': ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'],
        'video': ['video/mp4', 'video/avi', 'video/quicktime', 'video/x-ms-wmv'],
        'audio': ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg']
    };

    const allAllowedTypes = Object.values(allowedTypes).flat();
    
    if (allAllowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`File type not allowed. Allowed types: ${allAllowedTypes.join(', ')}`), false);
    }
};

// Multer upload instance
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 5 // Max 5 files per upload
    },
    fileFilter: fileFilter
});

// ============================================
// SUPABASE STORAGE HELPERS
// ============================================

/**
 * Upload file to Supabase Storage
 */
const uploadToSupabase = async (file, bucket, folder = '') => {
    try {
        if (!file) {
            throw new Error('No file provided');
        }

        // Generate unique filename
        const timestamp = Date.now();
        const randomString = crypto.randomBytes(8).toString('hex');
        const fileExtension = path.extname(file.originalname);
        const fileName = `${timestamp}-${randomString}${fileExtension}`;
        const filePath = folder ? `${folder}/${fileName}` : fileName;

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) {
            throw uploadError;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);

        return {
            url: urlData.publicUrl,
            path: filePath,
            fileName: file.originalname,
            fileSize: file.size,
            fileType: file.mimetype,
            readableSize: getReadableFileSize(file.size)
        };

    } catch (error) {
        console.error('❌ Upload to Supabase error:', error);
        throw error;
    }
};

/**
 * Delete file from Supabase Storage
 */
const deleteFromSupabase = async (bucket, filePath) => {
    try {
        if (!filePath) {
            return;
        }

        const { error } = await supabase.storage
            .from(bucket)
            .remove([filePath]);

        if (error) {
            throw error;
        }

        return true;

    } catch (error) {
        console.error('❌ Delete from Supabase error:', error);
        throw error;
    }
};

/**
 * Get file URL from Supabase Storage
 */
const getFileUrl = (bucket, filePath) => {
    if (!filePath) return null;
    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    return data.publicUrl;
};

// ============================================
// UPLOAD MIDDLEWARES
// ============================================

// Single file upload
const uploadSingle = (fieldName) => {
    return (req, res, next) => {
        upload.single(fieldName)(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === 'FILE_TOO_LARGE') {
                    return res.status(413).json({
                        error: 'File too large. Maximum size is 10MB.'
                    });
                }
                return res.status(400).json({
                    error: err.message
                });
            } else if (err) {
                return res.status(400).json({
                    error: err.message
                });
            }
            next();
        });
    };
};

// Multiple files upload
const uploadMultiple = (fieldName, maxCount = 5) => {
    return (req, res, next) => {
        upload.array(fieldName, maxCount)(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === 'FILE_TOO_LARGE') {
                    return res.status(413).json({
                        error: 'File too large. Maximum size is 10MB.'
                    });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(400).json({
                        error: `Maximum ${maxCount} files allowed.`
                    });
                }
                return res.status(400).json({
                    error: err.message
                });
            } else if (err) {
                return res.status(400).json({
                    error: err.message
                });
            }
            next();
        });
    };
};

// Upload with specific bucket and folder
const uploadToBucket = (bucket, folder = '') => {
    return async (req, res, next) => {
        try {
            if (!req.file && !req.files) {
                return next();
            }

            const files = req.files || [req.file];
            const uploadResults = [];

            for (const file of files) {
                const result = await uploadToSupabase(file, bucket, folder);
                uploadResults.push(result);
            }

            req.uploadedFiles = uploadResults;
            next();

        } catch (error) {
            console.error('❌ Upload error:', error);
            res.status(500).json({
                error: 'File upload failed: ' + error.message
            });
        }
    };
};

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Validate file type
 */
const validateFile = (file, allowedTypes) => {
    if (!file) return false;
    const mimeType = file.mimetype;
    return allowedTypes.includes(mimeType);
};

/**
 * Validate file size
 */
const validateFileSize = (file, maxSizeInMB = 10) => {
    if (!file) return false;
    const maxBytes = maxSizeInMB * 1024 * 1024;
    return file.size <= maxBytes;
};

// ============================================
// EXPORT
// ============================================

module.exports = {
    upload,
    uploadSingle,
    uploadMultiple,
    uploadToBucket,
    uploadToSupabase,
    deleteFromSupabase,
    getFileUrl,
    validateFile,
    validateFileSize
};