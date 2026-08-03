// routes/students.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');
const { studentValidationChains, idParam, paginationQuery, validate } = require('../middleware/validation');

/**
 * Permanently (HARD) delete a Supabase Auth user. Mirrors the helper in
 * routes/auth.js because routes/students.js is its own file and we don't
 * want a cross-import of module-level helpers. See auth.js helper docblock
 * for the soft-vs-hard delete rationale: soft delete keeps the email
 * blocked and hides rows from Dashboard Users view.
 */
const permanentlyDeleteAuthUser = async (userId) => {
  if (!userId) return;
  let lastErr = null;
  try {
    const { error } = await supabase.auth.admin.deleteUser(userId, true);
    if (!error) return;
    lastErr = error;
  } catch (e) {
    lastErr = e;
  }
  try {
    const { error } = await supabase
      .rpc('auth_delete_user_permanent', { user_id: userId });
    if (!error) return;
    lastErr = error;
  } catch (_) { /* rpc may not exist */ }
  try {
    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (!error) return;
    lastErr = error;
  } catch (_) { /* RLS may block; expected */ }
  console.warn('[students.js] permanentlyDeleteAuthUser: all branches failed for', userId, 'last error:', lastErr?.message || lastErr);
};

// ============================================
// GET ALL STUDENTS (Admin)
// ============================================
router.get('/', authenticate, requireAdmin, paginationQuery, validate, async (req, res) => {
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

    if (search && String(search).trim() !== '') {
      const s = String(search).trim();
      query = query.or(
        `name.ilike.%${s}%,` +
        `matric_no.ilike.%${s}%,` +
        `email.ilike.%${s}%`
      );
    }

    // status === 'all' means "no filter" — we must NOT add an eq('status','all')
    // clause, because no student row has that value, so the result set becomes
    // empty even though records exist.
    const normalizedStatus = typeof status === 'string' ? status.trim() : '';
    if (normalizedStatus && normalizedStatus !== 'all') {
      query = query.eq('status', normalizedStatus);
    }

    if (department && String(department).trim() !== '') {
      query = query.eq('department', String(department).trim());
    }

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, {
      students: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    }, 'Students retrieved successfully');
  } catch (error) {
    console.error('Students fetch error:', error);
    return errorResponse(res, 'Failed to fetch students', 500, error);
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

    return successResponse(res, {
      count: data.length,
      students: data
    }, 'Pending students retrieved successfully');
  } catch (error) {
    console.error('Pending students fetch error:', error);
    return errorResponse(res, 'Failed to fetch pending students', 500, error);
  }
});

// VERIFY STUDENT (Admin) - LEGACY ENDPOINT KEPT FOR BACKWARD COMPATIBILITY.
// Note: students are now auto-activated on signup (status='active'), so this route
// is rarely used in the new flow. Kept available for manual admin overrides / re-activation.
router.put('/:id/verify', authenticate, requireAdmin, idParam('id'), validate, async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return errorResponse(res, 'Invalid action. Use "approve" or "reject".', 400);
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
        return errorResponse(res, 'Student not found', 404);
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

    return successResponse(res, { student: data }, `Student ${action}d successfully`);

  } catch (error) {
    console.error('Student verification error:', error);
    return errorResponse(res, 'Failed to verify student', 500, error);
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
        return errorResponse(res, 'Student profile not found. Please contact support.', 404);
      }
      throw error;
    }

    return successResponse(res, data, 'Profile retrieved successfully');
  } catch (error) {
    console.error('Profile fetch error:', error);
    return errorResponse(res, 'Failed to load profile', 500, error);
  }
});

// ============================================
// UPDATE PROFILE
// ============================================
router.put('/me', authenticate, studentValidationChains.updateProfile, validate, async (req, res) => {
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

    return successResponse(res, { student: data }, 'Profile updated successfully');

  } catch (error) {
    console.error('Profile update error:', error);
    return errorResponse(res, 'Failed to update profile', 500, error);
  }
});

// ============================================
// UPLOAD PROFILE PICTURE
// ============================================
router.post('/me/profile-picture', authenticate, async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return errorResponse(res, 'Image URL is required', 400);
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

    return successResponse(res, { profile_picture_url: data.profile_picture_url }, 'Profile picture updated');

  } catch (error) {
    console.error('Profile picture update error:', error);
    return errorResponse(res, 'Failed to update profile picture', 500, error);
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
      return errorResponse(res, 'Student not found', 404);
    }

    // Delete student profile
    const { error: deleteError } = await supabase
      .from('students')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    // Delete auth user (if exists) — MUST use permanent (hard) delete,
    // otherwise the soft-deleted orphan blocks any future re-registration
    // of the same email and remains invisible in the default Dashboard view.
    if (student.user_id) {
      await permanentlyDeleteAuthUser(student.user_id);
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

    return successResponse(res, null, 'Student deleted successfully');

  } catch (error) {
    console.error('Student deletion error:', error);
    return errorResponse(res, 'Failed to delete student', 500, error);
  }
});

module.exports = router;
