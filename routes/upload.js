// backend/routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { ALLOWED_BUCKETS, resolveBucketFor, isAllowedBucket } = require('../middleware/upload');

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

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: JPEG, PNG, GIF, WebP, PDF'));
        }
    }
});

// ============================================
// UPLOAD FILE TO SPECIFIC BUCKET
// :bucket may be a raw bucket name OR a logical flow key (e.g. 'events')
// ============================================
router.post('/upload/:bucket', authenticate, upload.single('file'), async (req, res) => {
    try {
        const { bucket } = req.params;
        const file = req.file;
        const folder = req.body.folder || '';

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')} (or logical keys: events/past_questions/timetables/resources/profile_pictures/payment_proofs/voting_photos).`
            });
        }

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Validate bucket exists in Supabase
        const { data: bucketData, error: bucketError } = await supabase
            .storage
            .getBucket(resolvedBucket);

        if (bucketError || !bucketData) {
            return res.status(404).json({ error: `Bucket '${resolvedBucket}' not found in Supabase Storage. Create it via migrate script or dashboard.` });
        }

        // Generate unique filename
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 8);
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `${timestamp}-${randomString}.${fileExtension}`;
        const filePath = folder ? `${folder}/${fileName}` : fileName;

        // Upload to Supabase Storage
        const { data, error } = await supabase.storage
            .from(resolvedBucket)
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '3600',
                upsert: false
            });

        if (error) {
            console.error('Upload error:', error);
            return res.status(500).json({ error: 'Failed to upload file' });
        }

        // Get public URL
        const { data: urlData } = await supabase.storage
            .from(resolvedBucket)
            .getPublicUrl(filePath);

        res.json({
            success: true,
            message: 'File uploaded successfully',
            bucket: resolvedBucket,
            file: {
                name: file.originalname,
                size: file.size,
                type: file.mimetype,
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
        const { filePath } = req.body;

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')}.`
            });
        }

        if (!filePath) {
            return res.status(400).json({ error: 'File path is required' });
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
        const { folder = '' } = req.query;

        const resolvedBucket = resolveAndValidateBucket(bucket);
        if (!resolvedBucket) {
            return res.status(400).json({
                error: `Bucket or flow key not allowed. Allowed: ${ALLOWED_BUCKETS.join(', ')}.`
            });
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
