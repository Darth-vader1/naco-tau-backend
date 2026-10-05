// routes/resources.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

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

    return successResponse(res, {
      resources: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    }, 'Resources retrieved successfully');
  } catch (error) {
    console.error('Resources fetch error:', error);
    return errorResponse(res, 'Failed to fetch resources', 500, error);
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
        return errorResponse(res, 'Resource not found', 404);
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

    return successResponse(res, data, 'Resource retrieved successfully');
  } catch (error) {
    console.error('Resource fetch error:', error);
    return errorResponse(res, 'Failed to fetch resource', 500, error);
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
      return errorResponse(res, 'Title, resource type, and file URL are required', 400);
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

    return successResponse(res, { resource: data }, 'Resource created successfully', 201);

  } catch (error) {
    console.error('Resource creation error:', error);
    return errorResponse(res, 'Failed to create resource', 500, error);
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
        return errorResponse(res, 'Resource not found', 404);
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

    return successResponse(res, { resource: data }, 'Resource updated successfully');

  } catch (error) {
    console.error('Resource update error:', error);
    return errorResponse(res, 'Failed to update resource', 500, error);
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
      return errorResponse(res, 'Resource not found', 404);
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

    return successResponse(res, null, 'Resource deleted successfully');

  } catch (error) {
    console.error('Resource deletion error:', error);
    return errorResponse(res, 'Failed to delete resource', 500, error);
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
        return errorResponse(res, 'Resource not found', 404);
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

    return successResponse(res, {
      download_url: data.file_url,
      file_name: data.file_name
    }, 'Download processed successfully');

  } catch (error) {
    console.error('Resource download error:', error);
    return errorResponse(res, 'Failed to process download', 500, error);
  }
});

module.exports = router;
