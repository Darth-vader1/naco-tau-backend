// routes/students.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// ============================================
// GET ALL STUDENTS (Admin)
// ============================================
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search, 
      status,
      department 
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('students')
      .select('*', { count: 'exact' });

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,` +
        `matric_no.ilike.%${search}%,` +
        `email.ilike.%${search}%`
      );
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (department) {
      query = query.eq('department', department);
    }

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      students: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Students fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch students'
    });
  }
});

// ============================================
// GET PENDING STUDENTS (Admin)
// ============================================
router.get('/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      count: data.length,
      students: data
    });
  } catch (error) {
    console.error('Pending students fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch pending students'
    });
  }
});

// ============================================
// VERIFY STUDENT (Admin)
// ============================================
router.put('/:id/verify', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        error: 'Invalid action. Use "approve" or "reject".'
      });
    }

    const newStatus = action === 'approve' ? 'active' : 'rejected';

    const { data, error } = await supabase
      .from('students')
      .update({
        status: newStatus,
        verified_at: new Date().toISOString(),
        verified_by: req.userId
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Student not found'
        });
      }
      throw error;
    }

    // Log verification
    await auditLog({
      action: `student_${action}`,
      userId: req.userId,
      details: { 
        student_id: id, 
        student_email: data.email,
        student_name: data.name
      },
      ip: req.ip
    });

    // Send verification email (optional)
    // await sendVerificationEmail(data.email, action);

    res.json({
      success: true,
      message: `Student ${action}d successfully`,
      student: data
    });

  } catch (error) {
    console.error('Student verification error:', error);
    res.status(500).json({
      error: 'Failed to verify student'
    });
  }
});

// ============================================
// GET STUDENT PROFILE
// ============================================
router.get('/me', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Student profile not found. Please contact support.'
        });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({
      error: 'Failed to load profile'
    });
  }
});

// ============================================
// UPDATE PROFILE
// ============================================
router.put('/me', authenticate, async (req, res) => {
  try {
    const { 
      first_name, 
      last_name, 
      phone,
      bio,
      skills,
      github,
      linkedin,
      department
    } = req.body;

    const updates = {};
    if (first_name) updates.first_name = first_name;
    if (last_name) updates.last_name = last_name;
    if (phone) updates.phone = phone;
    if (bio) updates.bio = bio;
    if (skills) updates.skills = skills;
    if (github) updates.github = github;
    if (linkedin) updates.linkedin = linkedin;
    if (department) updates.department = department;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('students')
      .update(updates)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Profile updated successfully',
      student: data
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      error: 'Failed to update profile'
    });
  }
});

// ============================================
// UPLOAD PROFILE PICTURE
// ============================================
router.post('/me/profile-picture', authenticate, async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        error: 'Image URL is required'
      });
    }

    const { data, error } = await supabase
      .from('students')
      .update({ 
        profile_picture_url: imageUrl,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;

    // Log profile picture update
    await auditLog({
      action: 'profile_picture_update',
      userId: req.userId,
      details: { student_id: data.id },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Profile picture updated',
      profile_picture_url: data.profile_picture_url
    });

  } catch (error) {
    console.error('Profile picture update error:', error);
    res.status(500).json({
      error: 'Failed to update profile picture'
    });
  }
});

// ============================================
// DELETE STUDENT (Admin)
// ============================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get student info before delete
    const { data: student, error: fetchError } = await supabase
      .from('students')
      .select('user_id, email, name')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({
        error: 'Student not found'
      });
    }

    // Delete student profile
    const { error: deleteError } = await supabase
      .from('students')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    // Delete auth user (if exists)
    if (student.user_id) {
      await supabase.auth.admin.deleteUser(student.user_id)
        .catch(err => console.error('Auth user deletion error:', err));
    }

    // Log deletion
    await auditLog({
      action: 'student_deleted',
      userId: req.userId,
      details: { 
        student_id: id,
        student_email: student.email,
        student_name: student.name
      },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Student deleted successfully'
    });

  } catch (error) {
    console.error('Student deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete student'
    });
  }
});

module.exports = router;