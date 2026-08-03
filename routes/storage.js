// backend/routes/storage.js
//
// Storage bucket administration endpoints.
//
// The browser anon key CANNOT call Supabase storage admin APIs (getBucket,
// createBucket, listBuckets) reliably — on many projects they are 400'd
// before reaching any logic, and on the rest the response shape is
// ambiguous. This router exposes the admin-only subset of storage ops
// backed by the service_role key so the frontend can:
//
//   1. Idempotently ensure all 7 dedicated buckets exist (with public=on,
//      10 MiB file limit matching the settings the user already applied
//      in their dashboard).
//   2. Get the canonical list of verified buckets + write it into the
//      localStorage cache ("verifiedBuckets-v1") so ensureBucket() on the
//      frontend can skip all admin API calls entirely.
//
// All endpoints require ADMIN role (authenticate + requireAdmin middleware)
// because creating/listing buckets is a project-wide admin action.

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { ALLOWED_BUCKETS, BUCKETS, resolveBucketFor, isAllowedBucket } = require('../middleware/upload');

// File size limit applied to newly auto-created buckets: 10 MiB = 10_485_760,
// exactly matching the per-bucket settings shown to the user in their bucket
// JSON snapshot (so auto-provisioned buckets match the dashboard settings).
const DEFAULT_FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const PUBLIC_FLAG = true;

const DEFAULT_MIME_TYPES = Object.freeze([
  'image/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/*'
]);

/**
 * Sanitize a storage admin error for the HTTP response.
 * Supabase storage-admin SDK errors often have non-String .details like
 * the rest of the SDK, so coerce everything before concatenating messages.
 */
function adminErr(error, fallback) {
  if (!error) return fallback || 'Storage admin operation failed';
  const parts = [
    String(error.message || ''),
    String(error.code || ''),
    String(error.hint || ''),
    typeof error.details === 'string' ? error.details : ''
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : (fallback || String(error));
}

/**
 * Read all buckets from Supabase and return a map of bucketName → object.
 * Uses service_role key via backend config/supabase.js.
 */
async function listAllBuckets() {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`listBuckets failed: ${adminErr(error)}`);
  const map = new Map();
  for (const b of Array.isArray(data) ? data : []) {
    map.set(String(b.name || b.id), b);
  }
  return map;
}

async function createBucketIfMissing(bucketName, existingMap) {
  if (existingMap && existingMap.has(bucketName)) {
    return { bucketName, created: false, alreadyExisted: true };
  }
  const { data, error } = await supabase.storage.createBucket(bucketName, {
    public: PUBLIC_FLAG,
    fileSizeLimit: DEFAULT_FILE_SIZE_LIMIT,
    allowedMimeTypes: DEFAULT_MIME_TYPES
  });
  if (error) {
    // Supabase Storage will throw "already exists" style error if another
    // process created the bucket concurrently. Treat that as "not created
    // but existed" rather than a hard failure.
    const msg = adminErr(error).toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || msg.includes('duplicate')) {
      return { bucketName, created: false, alreadyExisted: true };
    }
    throw new Error(`Failed to create bucket "${bucketName}": ${adminErr(error)}`);
  }
  return { bucketName, created: true, alreadyExisted: false, raw: data };
}

/**
 * GET /api/storage/status
 * Returns:
 *   { allowedBuckets: [...], existing: [...], missing: [...], bucketMap: {...} }
 * No mutations — safe for admin dashboard polling / cache pre-warming.
 */
router.get('/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const existing = await listAllBuckets();
    const sorted = ALLOWED_BUCKETS.slice().sort();
    const present = sorted.filter(n => existing.has(n));
    const missing = sorted.filter(n => !existing.has(n));
    return res.json({
      success: true,
      allowedBuckets: sorted,
      existing: present,
      missing,
      bucketEnum: { ...BUCKETS }
    });
  } catch (err) {
    console.error('[storage/status] error:', err);
    return res.status(500).json({
      success: false,
      error: adminErr(err, 'Failed to query storage status')
    });
  }
});

/**
 * POST /api/storage/ensure-buckets
 * Idempotently creates every bucket in ALLOWED_BUCKETS that doesn't already
 * exist, applies the project's standard public + 10 MiB + mime whitelist
 * settings on newly created ones, and returns a detailed per-bucket report
 * plus the canonical verified list for the frontend to cache.
 *
 * Body (optional): { force?: boolean }
 *   force = true ignores the in-memory "checked in last 5 minutes" skip
 *           guard and re-lists buckets before deciding what to create.
 */
const lastEnsureRun = new Map(); // bucketName → timestamp of last create attempt

router.post('/ensure-buckets', authenticate, requireAdmin, async (req, res) => {
  try {
    const force = Boolean(req.body && req.body.force);
    const FIVE_MIN_MS = 5 * 60 * 1000;

    const existing = await listAllBuckets();
    const sorted = ALLOWED_BUCKETS.slice().sort();

    const results = [];
    let createdCount = 0;
    let skippedCount = 0;
    let errors = [];

    for (const bucketName of sorted) {
      if (!force && existing.has(bucketName)) {
        results.push({ bucketName, status: 'exists', note: 'already present in storage listBuckets' });
        skippedCount += 1;
        continue;
      }
      const lastAt = lastEnsureRun.get(bucketName) || 0;
      if (!force && !existing.has(bucketName) && Date.now() - lastAt < FIVE_MIN_MS) {
        results.push({
          bucketName,
          status: 'throttled',
          note: 'already attempted creation in the last 5 minutes; pass force=true to retry immediately'
        });
        skippedCount += 1;
        continue;
      }
      try {
        const res = await createBucketIfMissing(bucketName, existing);
        lastEnsureRun.set(bucketName, Date.now());
        if (res.created) {
          createdCount += 1;
          results.push({ bucketName, status: 'created', note: 'new bucket created with public=on, 10MiB limit' });
        } else {
          results.push({ bucketName, status: 'exists', note: 'did not need creation' });
          skippedCount += 1;
        }
      } catch (createErr) {
        lastEnsureRun.set(bucketName, Date.now());
        errors.push({ bucketName, error: adminErr(createErr) });
        results.push({ bucketName, status: 'error', error: adminErr(createErr) });
      }
    }

    // Re-list once to get the canonical list (ensures any parallel-create
    // wins are also reflected in the verified cache we return to frontend).
    const finalList = await listAllBuckets();
    const verified = sorted.filter(n => finalList.has(n));

    return res.status(errors.length ? 207 : 200).json({
      success: errors.length < sorted.length,
      verifiedBuckets: verified,
      allowedBuckets: sorted,
      bucketEnum: { ...BUCKETS },
      createdCount,
      skippedCount,
      errorCount: errors.length,
      errors,
      perBucket: results
    });
  } catch (err) {
    console.error('[storage/ensure-buckets] error:', err);
    return res.status(500).json({
      success: false,
      error: adminErr(err, 'Failed to ensure storage buckets')
    });
  }
});

/**
 * POST /api/storage/ensure-one
 * Ensures a single bucket or flow key exists (accepts logical keys like
 * 'events', 'past_questions'). Responds with create status + the canonical
 * verified bucket name so the caller can write to the cache.
 * Body: { bucket: string, force?: boolean }
 */
router.post('/ensure-one', authenticate, requireAdmin, async (req, res) => {
  try {
    const force = Boolean(req.body && req.body.force);
    const raw = String(req.body && req.body.bucket || '').trim();
    if (!raw) {
      return res.status(400).json({ success: false, error: '"bucket" body param required. May be a bucket name or logical flow key (e.g. "events").' });
    }
    const resolved = resolveBucketFor(raw, raw);
    if (!isAllowedBucket(resolved)) {
      return res.status(400).json({
        success: false,
        error: `Bucket or flow key not allowed. Allowed buckets: ${ALLOWED_BUCKETS.join(', ')}.`
      });
    }
    const existing = await listAllBuckets();
    const result = await createBucketIfMissing(resolved, existing);
    const finalList = await listAllBuckets();
    return res.json({
      success: true,
      resolved,
      alreadyExisted: result.alreadyExisted,
      created: result.created,
      verified: finalList.has(resolved),
      verifiedBuckets: ALLOWED_BUCKETS.slice().sort().filter(n => finalList.has(n))
    });
  } catch (err) {
    console.error('[storage/ensure-one] error:', err);
    return res.status(500).json({
      success: false,
      error: adminErr(err, 'Failed to ensure bucket')
    });
  }
});

module.exports = router;
