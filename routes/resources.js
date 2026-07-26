// routes/resources.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// ============================================
// GET ALL RESOURCES
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      type, 
      search,
      course 
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('academic_resources')
      .select('*', { count: 'exact' });

    if (type) {
      query = query.eq('resource_type', type);
    }

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }

    if (course) {
      query = query.eq('course', course);
    }

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      resources: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Resources fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch resources'
    });
  }
});

// ============================================
// GET RESOURCE BY ID
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('academic_resources')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Resource not found'
        });
      }
      throw error;
    }

    // Track resource view
    await supabase
      .from('resource_views')
      .insert([{
        resource_id: id,
        user_id: req.userId,
        viewed_at: new Date().toISOString()
      }])
      .catch(err => console.error('View tracking error:', err));

    res.json(data);
  } catch (error) {
    console.error('Resource fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch resource'
    });
  }
});

// ============================================
// CREATE RESOURCE (Admin)
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      resource_type,
      course,
      year,
      semester,
      file_url,
      file_name,
      file_size,
      file_type,
      author
    } = req.body;

    if (!title || !resource_type || !file_url) {
      return res.status(400).json({
        error: 'Title, resource type, and file URL are required'
      });
    }

    const { data, error } = await supabase
      .from('academic_resources')
      .insert([{
        title,
        description,
        resource_type,
        course,
        year,
        semester,
        file_url,
        file_name,
        file_size,
        file_type,
        author: author || req.user.email,
        uploaded_by: req.userId,
        is_active: true,
        download_count: 0,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    await auditLog({
      action: 'resource_created',
      userId: req.userId,
      details: { 
        resource_id: data.id,
        title: data.title,
        type: data.resource_type
      },
      ip: req.ip
    });

    res.status(201).json({
      success: true,
      message: 'Resource created successfully',
      resource: data
    });

  } catch (error) {
    console.error('Resource creation error:', error);
    res.status(500).json({
      error: 'Failed to create resource'
    });
  }
});

// ============================================
// UPDATE RESOURCE (Admin)
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('academic_resources')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Resource not found'
        });
      }
      throw error;
    }

    await auditLog({
      action: 'resource_updated',
      userId: req.userId,
      details: { 
        resource_id: id,
        title: data.title
      },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Resource updated successfully',
      resource: data
    });

  } catch (error) {
    console.error('Resource update error:', error);
    res.status(500).json({
      error: 'Failed to update resource'
    });
  }
});

// ============================================
// DELETE RESOURCE (Admin)
// ============================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get resource info before delete
    const { data: resource, error: fetchError } = await supabase
      .from('academic_resources')
      .select('title, file_url')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({
        error: 'Resource not found'
      });
    }

    // Delete the file from storage if it exists
    if (resource.file_url) {
      const filePath = resource.file_url.split('/').pop();
      await supabase.storage
        .from('resources')
        .remove([filePath])
        .catch(err => console.error('File deletion error:', err));
    }

    const { error } = await supabase
      .from('academic_resources')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await auditLog({
      action: 'resource_deleted',
      userId: req.userId,
      details: { 
        resource_id: id,
        title: resource.title
      },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Resource deleted successfully'
    });

  } catch (error) {
    console.error('Resource deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete resource'
    });
  }
});

// ============================================
// DOWNLOAD RESOURCE (Track downloads)
// ============================================
router.post('/:id/download', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Increment download count
    const { data, error } = await supabase
      .from('academic_resources')
      .update({ 
        download_count: supabase.raw('download_count + 1')
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Resource not found'
        });
      }
      throw error;
    }

    // Log download
    await supabase
      .from('resource_downloads')
      .insert([{
        resource_id: id,
        user_id: req.userId,
        downloaded_at: new Date().toISOString()
      }])
      .catch(err => console.error('Download tracking error:', err));

    res.json({
      success: true,
      download_url: data.file_url,
      file_name: data.file_name
    });

  } catch (error) {
    console.error('Resource download error:', error);
    res.status(500).json({
      error: 'Failed to process download'
    });
  }
});

module.exports = router;