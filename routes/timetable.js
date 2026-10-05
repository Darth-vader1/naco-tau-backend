// routes/timetables.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// GET ALL TIMETABLES
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      department,
      level,
      session 
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('timetables')
      .select('*', { count: 'exact' });

    if (department) query = query.eq('department', department);
    if (level) query = query.eq('level', level);
    if (session) query = query.eq('academic_session', session);

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, {
      timetables: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    }, 'Timetables retrieved successfully');
  } catch (error) {
    console.error('Timetables fetch error:', error);
    return errorResponse(res, 'Failed to fetch timetables', 500, error);
  }
});

// ============================================
// GET LATEST TIMETABLE
// ============================================
router.get('/latest', authenticate, async (req, res) => {
  try {
    const { department } = req.query;

    let query = supabase
      .from('timetables')
      .select('*')
      .eq('is_current', true);

    if (department) {
      query = query.eq('department', department);
    }

    const { data, error } = await query
      .order('version', { ascending: false })
      .limit(1);

    if (error) throw error;

    return successResponse(res, data[0] || null, 'Latest timetable retrieved successfully');
  } catch (error) {
    console.error('Latest timetable fetch error:', error);
    return errorResponse(res, 'Failed to fetch latest timetable', 500, error);
  }
});

// ============================================
// CREATE TIMETABLE (Admin)
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      department,
      level,
      semester,
      academic_session,
      file_url,
      file_name,
      description,
      is_current
    } = req.body;

    if (!title || !department || !file_url) {
      return errorResponse(res, 'Title, department, and file URL are required', 400);
    }

    // If this is set as current, unset others for this department
    if (is_current) {
      await supabase
        .from('timetables')
        .update({ is_current: false })
        .eq('department', department);
    }

    const { data, error } = await supabase
      .from('timetables')
      .insert([{
        title,
        department,
        level,
        semester,
        academic_session,
        file_url,
        file_name,
        description,
        is_current: is_current || false,
        version: 1,
        uploaded_by: req.userId,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    await auditLog({
      action: 'timetable_created',
      userId: req.userId,
      details: { 
        timetable_id: data.id,
        title: data.title,
        department: data.department
      },
      ip: req.ip
    });

    return successResponse(res, { timetable: data }, 'Timetable created successfully', 201);

  } catch (error) {
    console.error('Timetable creation error:', error);
    return errorResponse(res, 'Failed to create timetable', 500, error);
  }
});

// ============================================
// UPDATE TIMETABLE (Admin)
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Get current version
    const { data: current, error: fetchError } = await supabase
      .from('timetables')
      .select('version, department')
      .eq('id', id)
      .single();

    if (fetchError) {
      return errorResponse(res, 'Timetable not found', 404);
    }

    // Increment version for new upload
    if (updates.file_url) {
      updates.version = current.version + 1;
    }

    // If setting as current, unset others for this department
    if (updates.is_current) {
      await supabase
        .from('timetables')
        .update({ is_current: false })
        .eq('department', current.department)
        .neq('id', id);
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('timetables')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await auditLog({
      action: 'timetable_updated',
      userId: req.userId,
      details: { 
        timetable_id: id,
        version: data.version
      },
      ip: req.ip
    });

    return successResponse(res, { timetable: data }, 'Timetable updated successfully');

  } catch (error) {
    console.error('Timetable update error:', error);
    return errorResponse(res, 'Failed to update timetable', 500, error);
  }
});

// ============================================
// DELETE TIMETABLE (Admin)
// ============================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: timetable, error: fetchError } = await supabase
      .from('timetables')
      .select('title, file_url')
      .eq('id', id)
      .single();

    if (fetchError) {
      return errorResponse(res, 'Timetable not found', 404);
    }

    // Delete file from storage
    if (timetable.file_url) {
      const filePath = timetable.file_url.split('/').pop();
      await supabase.storage
        .from('timetables')
        .remove([filePath])
        .catch(err => console.error('File deletion error:', err));
    }

    const { error } = await supabase
      .from('timetables')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await auditLog({
      action: 'timetable_deleted',
      userId: req.userId,
      details: { 
        timetable_id: id,
        title: timetable.title
      },
      ip: req.ip
    });

    return successResponse(res, null, 'Timetable deleted successfully');

  } catch (error) {
    console.error('Timetable deletion error:', error);
    return errorResponse(res, 'Failed to delete timetable', 500, error);
  }
});

module.exports = router;
