// routes/auth.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { auditLog } = require('../middleware/audit');
const { validateEmail, validatePassword, validateMatricNo } = require('../utils/validators');
const { isAdminEmailAllowed, getAdminEmails, successResponse, errorResponse } = require('../utils/helpers');
const { authValidationChains, validate } = require('../middleware/validation');

// ============================================
// STUDENT REGISTRATION
// ============================================
router.post('/register', authLimiter, authValidationChains.register, validate, async (req, res) => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      matricNo,
      department,
      course,
      phone
    } = req.body;

    // Validate all fields
    if (!email || !password || !firstName || !lastName || !matricNo) {
      return errorResponse(res, 'All required fields must be filled', 400);
    }

    // Validate email format (@st.tau.edu.ng or @tau.edu.ng)
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(st\.)?tau\.edu\.ng$/;
    if (!emailRegex.test(email)) {
      return errorResponse(res, 'Please use a valid TAU student email (@st.tau.edu.ng or @tau.edu.ng)', 400);
    }

    // Validate password strength
    if (!validatePassword(password)) {
      return errorResponse(res, 'Password must be at least 8 characters with uppercase, lowercase, number and special character', 400);
    }

    // Validate matric number format
    if (!validateMatricNo(matricNo)) {
      return errorResponse(res, 'Invalid matric number format. Expected format: TAU/CS/20/001 or 23/10MSC014', 400);
    }

    // Check if email already exists
    const { data: existingStudent } = await supabase
      .from('students')
      .select('email, matric_no')
      .or(`email.eq.${email.toLowerCase()},matric_no.eq.${matricNo.toUpperCase()}`)
      .maybeSingle();

    if (existingStudent) {
      if (existingStudent.email === email.toLowerCase()) {
        return errorResponse(res, 'This email is already registered. Please login instead.', 409);
      }
      if (existingStudent.matric_no === matricNo.toUpperCase()) {
        return errorResponse(res, 'This matric number is already registered.', 409);
      }
    }

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email.toLowerCase(),
      password: password,
      options: {
        data: {
          full_name: `${firstName} ${lastName}`,
          first_name: firstName,
          last_name: lastName,
          role: 'student'
        }
      }
    });

    if (authError) {
      console.error('Signup error:', authError);
      return errorResponse(res, 'Registration failed. Please try again.', 400, authError);
    }

    // Create student profile
    const { error: profileError } = await supabase
      .from('students')
      .insert([{
        user_id: authData.user.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName,
        name: `${firstName} ${lastName}`,
        matric_no: matricNo.toUpperCase(),
        department: department || 'Computer Science',
        course: course || 'Computer Science',
        phone: phone || null,
        status: 'active', // Auto-activated on signup
        created_at: new Date().toISOString()
      }]);

    if (profileError) {
      console.error('Profile creation error:', profileError);
      await supabase.auth.admin.deleteUser(authData.user.id)
        .catch(err => console.error('Cleanup error:', err));
      
      return errorResponse(res, 'Registration failed. Please contact support.', 500, profileError);
    }

    // Log registration
    await auditLog({
      action: 'student_registration',
      userId: authData.user.id,
      details: { email, matricNo, firstName, lastName },
      ip: req.ip
    });

    return successResponse(res, {
      id: authData.user.id,
      email: authData.user.email
    }, 'Registration successful! Your account is now active. Please verify your email and login.', 201);

  } catch (error) {
    console.error('Registration error:', error);
    return errorResponse(res, 'Registration failed. Please try again.', 500, error);
  }
});

// ============================================
// STUDENT LOGIN
// ============================================
router.post('/login', authLimiter, authValidationChains.login, validate, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    // Validate email
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(st\.)?tau\.edu\.ng$/;
    if (!emailRegex.test(email)) {
      return errorResponse(res, 'Please use a valid TAU student email', 400);
    }

    // Attempt login with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password: password
    });

    if (error) {
      console.error('Login error:', error.message);
      return errorResponse(res, 'Invalid email or password. Please try again.', 401, error);
    }

    // Check student verification status
    const { data: studentProfile, error: profileError } = await supabase
      .from('students')
      .select('*')
      .eq('user_id', data.user.id)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('Profile fetch error:', profileError);
    }

    // Check if student is rejected
    if (studentProfile && studentProfile.status === 'rejected') {
      return res.status(403).json({
        success: false,
        error: 'Your account registration was rejected. Please contact support for assistance.',
        status: 'rejected',
        timestamp: new Date().toISOString()
      });
    }

    // Check if student is banned
    if (studentProfile && studentProfile.status === 'banned') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been suspended. Please contact support.',
        status: 'banned',
        timestamp: new Date().toISOString()
      });
    }

    // Log login activity
    await supabase
      .from('login_history')
      .insert([{
        user_id: data.user.id,
        email: data.user.email,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        login_time: new Date().toISOString()
      }])
      .catch(err => console.error('Login history error:', err));

    // Get user role
    const { data: roleData } = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', data.user.id)
      .single();

    const role = roleData?.role || 'student';

    return successResponse(res, {
      user: {
        id: data.user.id,
        email: data.user.email,
        role: role,
        student: studentProfile || null
      },
      session: data.session
    }, 'Login successful');

  } catch (error) {
    console.error('Login route error:', error);
    return errorResponse(res, 'Login failed. Please try again.', 500, error);
  }
});

// ============================================
// ADMIN LOGIN (Shared Account)
// ============================================
router.post('/admin/login', authLimiter, authValidationChains.adminLogin, validate, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Only allow emails in the ADMIN_EMAILS env allow-list (comma-separated)
    if (!isAdminEmailAllowed(email)) {
      const admins = getAdminEmails();
      console.warn(
        `[admin-login] Rejected email ${email} — allow-list: [${admins.join(', ')}]`
      );
      return errorResponse(res, 'Invalid admin credentials', 401);
    }

    // Attempt login with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password: password
    });

    if (error) {
      console.error('Admin login error:', error.message);
      return errorResponse(res, 'Invalid admin credentials', 401, error);
    }

    // Check if user has admin role
    const { data: adminData, error: adminError } = await supabase
      .from('admin_users')
      .select('*')
      .eq('user_id', data.user.id)
      .single();

    if (adminError || !adminData) {
      return errorResponse(res, 'Access denied. Admin privileges required.', 403);
    }

    // Log admin login
    await auditLog({
      action: 'admin_login',
      userId: data.user.id,
      details: { email: data.user.email },
      ip: req.ip
    });

    return successResponse(res, {
      user: {
        id: data.user.id,
        email: data.user.email,
        role: adminData.role,
        name: adminData.name
      },
      session: data.session
    }, 'Admin login successful');

  } catch (error) {
    console.error('Admin login error:', error);
    return errorResponse(res, 'Admin login failed. Please try again.', 500, error);
  }
});

// ============================================
// VERIFY SESSION
// ============================================
router.get('/verify', authenticate, async (req, res) => {
  try {
    // Get student profile if exists
    const { data: student } = await supabase
      .from('students')
      .select('*')
      .eq('user_id', req.userId)
      .maybeSingle();

    return successResponse(res, {
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        role: req.userRole || 'student',
        student: student || null
      }
    }, 'Session verified');
  } catch (error) {
    console.error('Verification error:', error);
    return errorResponse(res, 'Verification failed', 500, error);
  }
});

// ============================================
// LOGOUT
// ============================================
router.post('/logout', authenticate, async (req, res) => {
  try {
    await auditLog({
      action: 'logout',
      userId: req.userId,
      details: { email: req.user.email },
      ip: req.ip
    });

    const { error } = await supabase.auth.signOut();
    if (error) throw error;

    return successResponse(res, null, 'Logged out successfully');
  } catch (error) {
    console.error('Logout error:', error);
    return errorResponse(res, 'Logout failed. Please try again.', 500, error);
  }
});

// ============================================
// FORGOT PASSWORD
// ============================================
router.post('/forgot-password', authLimiter, authValidationChains.forgotPassword, validate, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !validateEmail(email)) {
      return errorResponse(res, 'Please provide a valid email address', 400);
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email.toLowerCase(), {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password.html`
    });

    if (error) {
      console.error('Password reset error:', error);
      // Don't reveal if email exists or not for security
      return successResponse(res, null, 'If your email is registered, you will receive a password reset link.');
    }

    return successResponse(res, null, 'Password reset link sent to your email.');

  } catch (error) {
    console.error('Forgot password error:', error);
    return errorResponse(res, 'Failed to send reset link. Please try again.', 500, error);
  }
});

module.exports = router;
