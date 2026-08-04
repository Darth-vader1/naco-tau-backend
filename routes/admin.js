// backend/routes/admin.js
//
// Admin-only generic CRUD pass-through for dashboard writes.
//
// All admin-dashboard writes (events, past questions, timetables, etc.) were
// being sent through the browser's anon Supabase client, which means RLS
// policies must explicitly allow INSERT/UPDATE/DELETE for the admin role.
// If RLS policies are missing (the common case on a fresh project), every
// admin write fails with Postgres error 42501: "new row violates row-level
// security policy for table X".
//
// This router bypasses that entirely by exposing a small, whitelisted
// pass-through using the backend's service_role Supabase client (which RLS
// never applies to) — admin identity is still enforced by the requireAdmin
// middleware before any DB call.

const express = require('express');
const router = express.Router();
const { validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');

// ============================================
// WHITELIST
// ============================================

const ALLOWED_ADMIN_TABLES = Object.freeze([
  'audit_logs',
  'events',
  'past_questions',
  'timetables',
  'academic_resources',
  'career_paths',
  'payment_verification'
]);

const TABLE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_PAYLOAD_KEYS = 64;
const MAX_STRING_VALUE_BYTES = 5 * 1024 * 1024; // 5 MiB per string
const MAX_JSON_VALUE_CHARS = 2 * 1024 * 1024; // 2 MiB serialized JSONB

function isAllowedTable(name) {
  return typeof name === 'string' && TABLE_NAME_RE.test(name) && ALLOWED_ADMIN_TABLES.includes(name);
}

function sanitizeDbErr(error) {
  if (!error) return 'unknown error';
  const parts = [
    String(error.message || ''),
    String(error.code || ''),
    String(error.hint || ''),
    typeof error.details === 'string' ? error.details : '',
    String(error.status || '')
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : String(error);
}

function validatePayloadShape(payload, opts = {}) {
  const { allowEmpty = false } = opts;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Payload must be a JSON object (not array or primitive).';
  }
  const keys = Object.keys(payload);
  if (!allowEmpty && keys.length === 0) {
    return 'Payload cannot be empty; at least one column is required.';
  }
  if (keys.length > MAX_PAYLOAD_KEYS) {
    return `Payload has ${keys.length} keys; maximum allowed is ${MAX_PAYLOAD_KEYS}.`;
  }
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return `Disallowed key in payload: "${key}".`;
    }
    if (!COLUMN_NAME_RE.test(key)) {
      return `Invalid column name in payload: "${key}" (letters, digits, underscores only, <=63 chars, starts with letter/underscore).`;
    }
    const v = payload[key];
    if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > MAX_STRING_VALUE_BYTES) {
      return `Value for column "${key}" exceeds ${MAX_STRING_VALUE_BYTES} bytes (5 MiB limit).`;
    }
    if (v !== null && v !== undefined && typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        if (s.length > MAX_JSON_VALUE_CHARS) return `JSON value for column "${key}" exceeds 2 MiB.`;
      } catch {
        return `Value for column "${key}" cannot be serialized as JSON.`;
      }
    }
  }
  return null;
}

// Apply auth globally: every route is admin-only.
router.use(authenticate);
router.use(requireAdmin);

router.param('table', (req, res, next, table) => {
  if (!isAllowedTable(table)) {
    return res.status(400).json({
      error: `Table not allowed for admin writes. Allowed: ${ALLOWED_ADMIN_TABLES.join(', ')}.`
    });
  }
  req.adminTable = table;
  next();
});

router.param('id', (req, res, next, id) => {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || /\0/.test(id)) {
    return res.status(400).json({ error: 'Invalid record id.' });
  }
  req.adminId = id;
  next();
});

// Lightweight body-sanity middleware: rejects non-object / prototype-pollution keys.
function validateBodyIsObject(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }
  for (const k of Object.keys(req.body)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      return res.status(400).json({ error: 'Disallowed key in request body.' });
    }
  }
  next();
}

// ============================================
// ROUTES
// ============================================

/**
 * POST /api/admin/:table
 * Insert a single row. Body = { ...column values }
 * Returns: { success, data: insertedRow, count }
 */
router.post('/:table', validateBodyIsObject, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed.', details: errors.array() });
    }
    const shapeErr = validatePayloadShape(req.body);
    if (shapeErr) return res.status(400).json({ error: shapeErr });

    const { data, error } = await supabase
      .from(req.adminTable)
      .insert(req.body)
      .select()
      .maybeSingle();

    if (error) {
      console.error(`[admin/POST ${req.adminTable}] error:`, error);
      return res.status(error.status || 500).json({
        error: `Insert into ${req.adminTable} failed: ${sanitizeDbErr(error)}`
      });
    }
    return res.json({ success: true, data: data || null, count: data ? 1 : 0 });
  } catch (err) {
    console.error(`[admin/POST ${req.adminTable}] exception:`, err);
    return res.status(500).json({ error: `Unexpected error inserting into ${req.adminTable}.` });
  }
});

/**
 * PUT /api/admin/:table/:id
 * Update a single row by primary key = id. Body = patch object.
 * The id column itself is automatically removed from the patch to prevent
 * accidental overwrites.
 */
router.put('/:table/:id', validateBodyIsObject, async (req, res) => {
  try {
    const shapeErr = validatePayloadShape(req.body);
    if (shapeErr) return res.status(400).json({ error: shapeErr });
    if (Object.prototype.hasOwnProperty.call(req.body, 'id')) {
      delete req.body.id;
    }
    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Update body is empty; nothing to patch.' });
    }

    const { data, error } = await supabase
      .from(req.adminTable)
      .update(req.body)
      .eq('id', req.adminId)
      .select()
      .maybeSingle();

    if (error) {
      console.error(`[admin/PUT ${req.adminTable}/${req.adminId}] error:`, error);
      return res.status(error.status || 500).json({
        error: `Update ${req.adminTable} failed: ${sanitizeDbErr(error)}`
      });
    }
    return res.json({ success: true, data: data || null, count: data ? 1 : 0 });
  } catch (err) {
    console.error(`[admin/PUT ${req.adminTable}/${req.adminId}] exception:`, err);
    return res.status(500).json({ error: `Unexpected error updating ${req.adminTable}.` });
  }
});

/**
 * DELETE /api/admin/:table/:id
 * Delete a single row by id.
 */
router.delete('/:table/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from(req.adminTable)
      .delete()
      .eq('id', req.adminId);

    if (error) {
      console.error(`[admin/DELETE ${req.adminTable}/${req.adminId}] error:`, error);
      return res.status(error.status || 500).json({
        error: `Delete from ${req.adminTable} failed: ${sanitizeDbErr(error)}`
      });
    }
    return res.json({ success: true, count: 1 });
  } catch (err) {
    console.error(`[admin/DELETE ${req.adminTable}/${req.adminId}] exception:`, err);
    return res.status(500).json({ error: `Unexpected error deleting from ${req.adminTable}.` });
  }
});

/**
 * POST /api/admin/:table/batch-update
 * Bulk update many rows using WHERE column = value equality filters.
 * Body: { filter: { eq: { column: value, ... } }, patch: { column: value, ... } }
 *
 * Example (clear all is_current flags before inserting a new timetable):
 *   POST /api/admin/timetables/batch-update
 *   body: { filter: { eq: { is_current: true } }, patch: { is_current: false } }
 */
router.post('/:table/batch-update', validateBodyIsObject, async (req, res) => {
  try {
    const { filter, patch } = req.body || {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: '"patch" must be an object of column -> value pairs.' });
    }
    if (!filter || !filter.eq || typeof filter.eq !== 'object' || Array.isArray(filter.eq)) {
      return res.status(400).json({
        error: '"filter.eq" is required and must be a non-empty object of column -> value pairs (for safety, at least one filter is mandatory).'
      });
    }
    const eqEntries = Object.entries(filter.eq);
    if (eqEntries.length === 0) {
      return res.status(400).json({
        error: '"filter.eq" must contain at least one column -> value pair. You cannot update every row in the table at once.'
      });
    }
    const patchShapeErr = validatePayloadShape(patch);
    if (patchShapeErr) return res.status(400).json({ error: patchShapeErr });

    for (const [col] of eqEntries) {
      if (!COLUMN_NAME_RE.test(col)) {
        return res.status(400).json({ error: `Invalid column in filter.eq: "${col}".` });
      }
    }

    let query = supabase.from(req.adminTable).update(patch);
    for (const [col, val] of eqEntries) {
      query = query.eq(col, val);
    }

    const { error, count } = await query;
    if (error) {
      console.error(`[admin/batch-update ${req.adminTable}] error:`, error);
      return res.status(error.status || 500).json({
        error: `Batch update on ${req.adminTable} failed: ${sanitizeDbErr(error)}`
      });
    }
    return res.json({ success: true, count: count ?? null });
  } catch (err) {
    console.error(`[admin/batch-update ${req.adminTable}] exception:`, err);
    return res.status(500).json({ error: `Unexpected error batch-updating ${req.adminTable}.` });
  }
});

module.exports = router;
// backend/routes/admin.js - Add this to your existing routes

const { sendBulkEmail, getEmailTemplate } = require('../services/email');

// ============================================
// CREATE ACADEMIC RESOURCE WITH EMAIL
// ============================================
router.post('/academic_resources', requireAdmin, async (req, res) => {
    try {
        const { 
            title, 
            description, 
            resourceType, 
            course, 
            year, 
            semester, 
            file_url, 
            file_name,
            file_size,
            file_type,
            author,
            category
        } = req.body;

        console.log('📝 Creating academic resource:', { title, resourceType });

        // 1. Insert into database
        const insertData = {
            title,
            description: description || '',
            resource_type: resourceType,
            course: course || '',
            year: year ? parseInt(year) : null,
            semester: semester || '',
            file_url,
            file_name: file_name || '',
            file_size: file_size ? parseInt(file_size) : 0,
            file_type: file_type || '',
            author: author || '',
            category: category || '',
            uploaded_by: req.user?.userId || null,
            is_active: true,
            download_count: 0
        };

        const { data, error } = await supabase
            .from('academic_resources')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            console.error('❌ DB error:', error);
            return res.status(500).json({ 
                error: `Insert failed: ${error.message}` 
            });
        }

        console.log('✅ Resource created:', data.id);

        // 2. Send email notification (async - don't wait)
        try {
            const html = getEmailTemplate('new_resource', data);
            
            // Don't await - send in background
            sendBulkEmail({
                subject: `📚 New Resource: ${data.title}`,
                html,
                text: `New resource available: ${data.title}\nType: ${data.resource_type}\nCourse: ${data.course || 'General'}`
            }).then(result => {
                console.log(`✅ Email notification sent to ${result.sent} students`);
            }).catch(err => {
                console.error('❌ Email notification failed:', err);
            });
        } catch (emailError) {
            console.error('❌ Email error:', emailError);
            // Don't fail the request if email fails
        }

        res.json({
            success: true,
            message: 'Resource created successfully',
            data
        });

    } catch (error) {
        console.error('❌ Create resource error:', error);
        res.status(500).json({ error: 'Failed to create resource: ' + error.message });
    }
});

// ============================================
// CREATE EVENT WITH EMAIL
// ============================================
router.post('/events', requireAdmin, async (req, res) => {
    try {
        const { title, description, date, time, location, image_url, event_type } = req.body;

        // 1. Insert into database
        const { data, error } = await supabase
            .from('events')
            .insert({
                title,
                description: description || '',
                date,
                time: time || null,
                location: location || '',
                image_url: image_url || '',
                event_type: event_type || 'general',
                is_active: true,
                created_by: req.user?.userId || null
            })
            .select()
            .single();

        if (error) {
            console.error('❌ DB error:', error);
            return res.status(500).json({ error: 'Failed to create event' });
        }

        console.log('✅ Event created:', data.id);

        // 2. Send email notification (async)
        try {
            const html = getEmailTemplate('new_event', data);
            
            sendBulkEmail({
                subject: `🎉 New Event: ${data.title}`,
                html,
                text: `New event: ${data.title}\nDate: ${data.date}\nLocation: ${data.location || 'TBA'}`
            }).then(result => {
                console.log(`✅ Event notification sent to ${result.sent} students`);
            }).catch(err => {
                console.error('❌ Event notification failed:', err);
            });
        } catch (emailError) {
            console.error('❌ Email error:', emailError);
        }

        res.json({
            success: true,
            message: 'Event created successfully',
            data
        });

    } catch (error) {
        console.error('❌ Create event error:', error);
        res.status(500).json({ error: 'Failed to create event' });
    }
});
// backend/routes/admin.js - Add this route

