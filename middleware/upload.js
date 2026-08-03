// backend/middleware/upload.js
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { validateFileType, getReadableFileSize } = require('../utils/validators');

// ============================================
// DEDICATED STORAGE BUCKETS
// Single source of truth for all 7 buckets provisioned in Supabase Storage.
// Every upload flow (both middleware helpers and route-level direct uploads)
// should resolve logical flow keys through `resolveBucketFor()` so that all
// uploads land in the right bucket — never the legacy monolithic one.
// ============================================

const BUCKETS = Object.freeze({
  PAST_QUESTIONS: 'past-questions',
  TIMETABLES: 'timetables',
  RESOURCES: 'resources',
  EVENT_IMAGES: 'event-images',
  PAYMENT_PROOFS: 'payment-proofs',
  PROFILE_PICTURES: 'profile-pictures',
  VOTING_PHOTOS: 'voting-photos'
});

const ALLOWED_BUCKETS = Object.freeze(Object.values(BUCKETS));

const BUCKET_MAP = Object.freeze({
  events: BUCKETS.EVENT_IMAGES,
  event_images: BUCKETS.EVENT_IMAGES,
  'event-images': BUCKETS.EVENT_IMAGES,
  past_questions: BUCKETS.PAST_QUESTIONS,
  'past-questions': BUCKETS.PAST_QUESTIONS,
  pastQuestions: BUCKETS.PAST_QUESTIONS,
  timetables: BUCKETS.TIMETABLES,
  timetable: BUCKETS.TIMETABLES,
  resources: BUCKETS.RESOURCES,
  academic_resources: BUCKETS.RESOURCES,
  'academic-resources': BUCKETS.RESOURCES,
  profile_pictures: BUCKETS.PROFILE_PICTURES,
  'profile-pictures': BUCKETS.PROFILE_PICTURES,
  profile: BUCKETS.PROFILE_PICTURES,
  avatar: BUCKETS.PROFILE_PICTURES,
  payment_proofs: BUCKETS.PAYMENT_PROOFS,
  'payment-proofs': BUCKETS.PAYMENT_PROOFS,
  payment: BUCKETS.PAYMENT_PROOFS,
  voting_photos: BUCKETS.VOTING_PHOTOS,
  'voting-photos': BUCKETS.VOTING_PHOTOS,
  voting: BUCKETS.VOTING_PHOTOS,
  candidates: BUCKETS.VOTING_PHOTOS
});

function resolveBucketFor(folderOrKey, fallback) {
  if (!folderOrKey) return fallback || null;
  const key = String(folderOrKey).trim().toLowerCase();
  if (BUCKET_MAP[key]) return BUCKET_MAP[key];
  if (ALLOWED_BUCKETS.includes(key)) return key;
  return fallback || null;
}

function isAllowedBucket(bucket) {
  return ALLOWED_BUCKETS.includes(bucket);
}

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
 *
 * Accepts either a raw bucket name OR a logical flow key — `resolveBucketFor`
 * maps it to one of the 7 dedicated buckets. Throws if the resolved bucket
 * isn't in the ALLOWED_BUCKETS whitelist, so direct callers can't write to
 * arbitrary buckets even if called outside the `uploadToBucket` middleware.
 */
const uploadToSupabase = async (file, bucketOrKey, folder = '') => {
    try {
        if (!file) {
            throw new Error('No file provided');
        }

        const bucket = resolveBucketFor(bucketOrKey, bucketOrKey);
        if (!bucket || !isAllowedBucket(bucket)) {
            throw new Error(
                `Bucket or flow key not allowed: "${bucketOrKey}". ` +
                `Allowed buckets: ${ALLOWED_BUCKETS.join(', ')} ` +
                `(or logical keys: events/past_questions/timetables/resources/profile_pictures/payment_proofs/voting_photos).`
            );
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
            bucket,
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
const deleteFromSupabase = async (bucketOrKey, filePath) => {
    try {
        if (!filePath) {
            return;
        }

        const bucket = resolveBucketFor(bucketOrKey, bucketOrKey);
        if (!bucket || !isAllowedBucket(bucket)) {
            throw new Error(
                `Bucket or flow key not allowed for deletion: "${bucketOrKey}". Allowed: ${ALLOWED_BUCKETS.join(', ')}.`
            );
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
const getFileUrl = (bucketOrKey, filePath) => {
    if (!filePath) return null;
    const bucket = resolveBucketFor(bucketOrKey, bucketOrKey);
    if (!bucket || !isAllowedBucket(bucket)) return null;
    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    return data?.publicUrl ?? null;
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
// Accepts either a raw bucket name (e.g. 'event-images') or a logical folder
// key (e.g. 'events') — resolveBucketFor maps it to the dedicated bucket.
const uploadToBucket = (bucketOrKey, folder = '') => {
    return async (req, res, next) => {
        try {
            if (!req.file && !req.files) {
                return next();
            }

            const bucket = resolveBucketFor(bucketOrKey, bucketOrKey);
            if (!isAllowedBucket(bucket)) {
                return res.status(400).json({
                    error: `Invalid bucket or flow key "${bucketOrKey}". Allowed buckets: ${ALLOWED_BUCKETS.join(', ')}.`
                });
            }

            const files = req.files || [req.file];
            const uploadResults = [];

            for (const file of files) {
                const result = await uploadToSupabase(file, bucket, folder);
                uploadResults.push(result);
            }

            req.uploadedFiles = uploadResults;
            req.resolvedBucket = bucket;
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
    BUCKETS,
    ALLOWED_BUCKETS,
    BUCKET_MAP,
    resolveBucketFor,
    isAllowedBucket,
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