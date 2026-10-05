// backend/routes/upload.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const multer = require('multer');
const FileType = require('file-type');
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { ALLOWED_BUCKETS, BUCKETS, resolveBucketFor, isAllowedBucket } = require('../middleware/upload');

/**
 * Buckets any authenticated student may write to (their own folder only).
 * Every other bucket (events, resources, timetables, past questions, voting
 * photos) is admin-only.
 */
const STUDENT_WRITABLE_BUCKETS = Object.freeze([
    BUCKETS.PAYMENT_PROOFS,
    BUCKETS.PROFILE_PICTURES
]);

// Verified (magic-byte) MIME type -> extension we are willing to store.
const ALLOWED_TYPES = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf'
});

const FOLDER_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,3}$/;
// Object keys we generate look like: [folder/]<ts>-<hex>.<ext>
const OBJECT_PATH_RE = /^[A-Za-z0-9_\-\/]+\.[A-Za-z0-9]{1,5}$/;

function isSafeRelativePath(p, re) {
    return typeof p === 'string'
        && p.length > 0
        && p.length <= 300
        && !p.includes('..')
        && !p.startsWith('/')
        && !p.includes('//')
        && re.test(p);
}

/**
 * Resolve and validate a :bucket path parameter.
 *
 * Accepts either a raw bucket name or a logical flow key (e.g. 'events' →
 * 'event-images'). Returns a validated bucket name or null if the
 * resolved bucket is not in the ALLOWED_BUCKETS whitelist.
 */
function resolveAndValidateBucket(bucketParam) {
    const resolved = resolveBucketFor(bucketParam, bucketParam);
    return isAllowedBucket(resolved) ? resolved : null;
}

const isAdminRole = (req) => req.userRole === 'admin' || req.userRole === 'super_admin';

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 1
    },
    fileFilter: (req, file, cb) => {
        // First-pass filter on the client-declared type; the real type is verified
        // from the file bytes in the handler.
        if (ALLOWED_TYPES[file.mimetype]) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: JPEG, PNG, GIF, WebP, PDF'));
        }
    }
});

// Run multer and translate its errors into proper 4xx responses.
const singleFile = (field) => (req, res, next) => {
    upload.single(field)(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
            }
            return res.status(400).json({ error: 'Invalid upload request.' });
        }
        return res.status(400).json({ error: err.message });
    });
};

// ============================================
// UPLOAD FILE TO SPECIFIC BUCKET
// :bucket may be a raw bucket name OR a logical flow key (e.g. 'events')
// ============================================
router.post('/upload/:bucket', authenticate, singleFile('file'), async (req, res) => {
    try {
        const { bucket } = req.params;
        const file = req.file;

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')} (or logical keys: events/past_questions/timetables/resources/profile_pictures/payment_proofs/voting_photos).`
            });
        }

        // Authorization: students may only write to their own folder in the
        // student-writable buckets. Everything else requires an admin role.
        const admin = isAdminRole(req);
        if (!admin && !STUDENT_WRITABLE_BUCKETS.includes(resolvedBucket)) {
            return res.status(403).json({ error: 'You are not allowed to upload to this bucket.' });
        }

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Verify the real content type from the bytes (client mimetype is untrusted).
        const detected = await FileType.fromBuffer(file.buffer);
        if (!detected || !ALLOWED_TYPES[detected.mime]) {
            return res.status(400).json({ error: 'File content does not match an allowed type (JPEG, PNG, GIF, WebP, PDF).' });
        }

        // Folder: students are pinned to their own user id; admins may choose a
        // sanitized sub-folder.
        let folder = '';
        if (admin) {
            const requested = (req.body && typeof req.body.folder === 'string') ? req.body.folder.trim() : '';
            if (requested) {
                if (!isSafeRelativePath(requested, FOLDER_RE)) {
                    return res.status(400).json({ error: 'Invalid folder name.' });
                }
                folder = requested;
            }
        } else {
            folder = req.userId;
        }

        // Validate bucket exists in Supabase
        const { data: bucketData, error: bucketError } = await supabase
            .storage
            .getBucket(resolvedBucket);

        if (bucketError || !bucketData) {
            return res.status(404).json({ error: `Bucket '${resolvedBucket}' not found in Supabase Storage. Create it via migrate script or dashboard.` });
        }

        // Server-generated filename; extension comes from the verified type only.
        const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ALLOWED_TYPES[detected.mime]}`;
        const filePath = folder ? `${folder}/${fileName}` : fileName;

        // Upload to Supabase Storage
        const { error } = await supabase.storage
            .from(resolvedBucket)
            .upload(filePath, file.buffer, {
                contentType: detected.mime,
                cacheControl: '3600',
                upsert: false
            });

        if (error) {
            console.error('Upload error:', error);
            return res.status(500).json({ error: 'Failed to upload file' });
        }

        // Get public URL
        const { data: urlData } = supabase.storage
            .from(resolvedBucket)
            .getPublicUrl(filePath);

        res.json({
            success: true,
            message: 'File uploaded successfully',
            bucket: resolvedBucket,
            file: {
                name: file.originalname,
                size: file.size,
                type: detected.mime,
                path: filePath,
                url: urlData.publicUrl
            }
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ============================================
// DELETE FILE
// ============================================
router.delete('/delete/:bucket', authenticate, requireAdmin, async (req, res) => {
    try {
        const { bucket } = req.params;
        const { filePath } = req.body || {};

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')}.`
            });
        }

        if (!filePath) {
            return res.status(400).json({ error: 'File path is required' });
        }
        if (!isSafeRelativePath(filePath, OBJECT_PATH_RE)) {
            return res.status(400).json({ error: 'Invalid file path.' });
        }

        const { error } = await supabase.storage
            .from(resolvedBucket)
            .remove([filePath]);

        if (error) {
            console.error('Delete error:', error);
            return res.status(500).json({ error: 'Failed to delete file' });
        }

        res.json({
            success: true,
            message: 'File deleted successfully',
            bucket: resolvedBucket
        });

    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// ============================================
// LIST FILES IN BUCKET
// ============================================
router.get('/list/:bucket', authenticate, requireAdmin, async (req, res) => {
    try {
        const { bucket } = req.params;
        const folder = typeof req.query.folder === 'string' ? req.query.folder : '';

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')}.`
            });
        }

        if (folder && !isSafeRelativePath(folder, FOLDER_RE)) {
            return res.status(400).json({ error: 'Invalid folder name.' });
        }

        const { data, error } = await supabase.storage
            .from(resolvedBucket)
            .list(folder || '');

        if (error) {
            console.error('List error:', error);
            return res.status(500).json({ error: 'Failed to list files' });
        }

        res.json({
            success: true,
            bucket: resolvedBucket,
            files: data
        });

    } catch (error) {
        console.error('List error:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

module.exports = router;
