// routes/career.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// GET ALL CAREER PATHS
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      category,
      search 
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('career_paths')
      .select('*', { count: 'exact' });

    if (category) {
      query = query.eq('category', category);
    }

    if (search) {
      query = query.or(
        `title.ilike.%${search}%,` +
        `description.ilike.%${search}%,` +
        `skills.cs.{${search}}`
      );
    }

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, {
      careers: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    }, 'Career paths retrieved successfully');
  } catch (error) {
    console.error('Career paths fetch error:', error);
    return errorResponse(res, 'Failed to fetch career paths', 500, error);
  }
});

// ============================================
// GET SINGLE CAREER PATH
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('career_paths')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Career path not found', 404);
      }
      throw error;
    }

    return successResponse(res, data, 'Career path retrieved successfully');
  } catch (error) {
    console.error('Career fetch error:', error);
    return errorResponse(res, 'Failed to fetch career path', 500, error);
  }
});

// ============================================
// CREATE CAREER PATH (Admin)
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      skills,
      tools,
      roadmap,
      required_education,
      salary_range,
      job_outlook,
      resources
    } = req.body;

    if (!title || !description || !category) {
      return errorResponse(res, 'Title, description, and category are required', 400);
    }

    const { data, error } = await supabase
      .from('career_paths')
      .insert([{
        title,
        description,
        category,
        skills: skills || [],
        tools: tools || [],
        roadmap: roadmap || [],
        required_education: required_education || 'Computer Science Degree',
        salary_range: salary_range || null,
        job_outlook: job_outlook || null,
        resources: resources || [],
        created_by: req.userId,
        is_active: true,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    await auditLog({
      action: 'career_path_created',
      userId: req.userId,
      details: { 
        career_id: data.id,
        title: data.title,
        category: data.category
      },
      ip: req.ip
    });

    return successResponse(res, { career: data }, 'Career path created successfully', 201);

  } catch (error) {
    console.error('Career creation error:', error);
    return errorResponse(res, 'Failed to create career path', 500, error);
  }
});

// ============================================
// UPDATE CAREER PATH (Admin)
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('career_paths')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Career path not found', 404);
      }
      throw error;
    }

    await auditLog({
      action: 'career_path_updated',
      userId: req.userId,
      details: { 
        career_id: id,
        title: data.title
      },
      ip: req.ip
    });

    return successResponse(res, { career: data }, 'Career path updated successfully');

  } catch (error) {
    console.error('Career update error:', error);
    return errorResponse(res, 'Failed to update career path', 500, error);
  }
});

// ============================================
// DELETE CAREER PATH (Admin)
// ============================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: career, error: fetchError } = await supabase
      .from('career_paths')
      .select('title')
      .eq('id', id)
      .single();

    if (fetchError) {
      return errorResponse(res, 'Career path not found', 404);
    }

    const { error } = await supabase
      .from('career_paths')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await auditLog({
      action: 'career_path_deleted',
      userId: req.userId,
      details: { 
        career_id: id,
        title: career.title
      },
      ip: req.ip
    });

    return successResponse(res, null, 'Career path deleted successfully');

  } catch (error) {
    console.error('Career deletion error:', error);
    return errorResponse(res, 'Failed to delete career path', 500, error);
  }
});

// ============================================
// SAVE CAREER PATH (Student)
// ============================================
router.post('/:id/save', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if already saved
    const { data: existing, error: checkError } = await supabase
      .from('saved_careers')
      .select('id')
      .eq('career_id', id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (existing) {
      return errorResponse(res, 'Career path already saved', 409);
    }

    const { data, error } = await supabase
      .from('saved_careers')
      .insert([{
        career_id: id,
        user_id: req.userId,
        saved_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    return successResponse(res, { saved: data }, 'Career path saved successfully');

  } catch (error) {
    console.error('Save career error:', error);
    return errorResponse(res, 'Failed to save career path', 500, error);
  }
});

// ============================================
// GET SAVED CAREERS (Student)
// ============================================
router.get('/saved/my', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('saved_careers')
      .select(`
        id,
        saved_at,
        career_paths:* 
      `)
      .eq('user_id', req.userId)
      .order('saved_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, data || [], 'Saved careers retrieved successfully');
  } catch (error) {
    console.error('Saved careers fetch error:', error);
    return errorResponse(res, 'Failed to fetch saved careers', 500, error);
  }
});

module.exports = router;
