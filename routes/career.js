// routes/career.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

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

    res.json({
      careers: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Career paths fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch career paths'
    });
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
        return res.status(404).json({
          error: 'Career path not found'
        });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Career fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch career path'
    });
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
      return res.status(400).json({
        error: 'Title, description, and category are required'
      });
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

    res.status(201).json({
      success: true,
      message: 'Career path created successfully',
      career: data
    });

  } catch (error) {
    console.error('Career creation error:', error);
    res.status(500).json({
      error: 'Failed to create career path'
    });
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
        return res.status(404).json({
          error: 'Career path not found'
        });
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

    res.json({
      success: true,
      message: 'Career path updated successfully',
      career: data
    });

  } catch (error) {
    console.error('Career update error:', error);
    res.status(500).json({
      error: 'Failed to update career path'
    });
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
      return res.status(404).json({
        error: 'Career path not found'
      });
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

    res.json({
      success: true,
      message: 'Career path deleted successfully'
    });

  } catch (error) {
    console.error('Career deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete career path'
    });
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
      return res.status(409).json({
        error: 'Career path already saved'
      });
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

    res.json({
      success: true,
      message: 'Career path saved successfully',
      saved: data
    });

  } catch (error) {
    console.error('Save career error:', error);
    res.status(500).json({
      error: 'Failed to save career path'
    });
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

    res.json(data || []);
  } catch (error) {
    console.error('Saved careers fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch saved careers'
    });
  }
});

module.exports = router;