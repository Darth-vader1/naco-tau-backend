// routes/auth.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { auditLog } = require('../middleware/audit');
const { validateEmail, validatePassword, validateMatricNo } = require('../utils/validators');

// ============================================
// STUDENT REGISTRATION
// ============================================
router.post('/register', authLimiter, async (req, res) => {
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
      return res.status(400).json({
        error: 'All required fields must be filled'
      });
    }

    // Validate email format (@st.tau.edu.ng or @tau.edu.ng)
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(st\.)?tau\.edu\.ng$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Please use a valid TAU student email (@st.tau.edu.ng or @tau.edu.ng)'
      });
    }

    // Validate password strength
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters with uppercase, lowercase, number and special character'
      });
    }

    // Validate matric number format
    if (!validateMatricNo(matricNo)) {
      return res.status(400).json({
        error: 'Invalid matric number format. Expected format: TAU/CS/20/001'
      });
    }

    // Check if email already exists
    const { data: existingStudent } = await supabase
      .from('students')
      .select('email, matric_no')
      .or(`email.eq.${email.toLowerCase()},matric_no.eq.${matricNo.toUpperCase()}`)
      .maybeSingle();

    if (existingStudent) {
      if (existingStudent.email === email.toLowerCase()) {
        return res.status(409).json({
          error: 'This email is already registered. Please login instead.'
        });
      }
      if (existingStudent.matric_no === matricNo.toUpperCase()) {
        return res.status(409).json({
          error: 'This matric number is already registered.'
        });
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
      return res.status(400).json({
        error: 'Registration failed. Please try again.'
      });
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
        status: 'pending', // Requires admin verification
        created_at: new Date().toISOString()
      }]);

    if (profileError) {
      console.error('Profile creation error:', profileError);
      await supabase.auth.admin.deleteUser(authData.user.id)
        .catch(err => console.error('Cleanup error:', err));
      
      return res.status(500).json({
        error: 'Registration failed. Please contact support.'
      });
    }

    // Log registration
    await auditLog({
      action: 'student_registration',
      userId: authData.user.id,
      details: { email, matricNo, firstName, lastName },
      ip: req.ip
    });

    res.status(201).json({
      success: true,
      message: 'Registration successful! Please check your email to verify your account. Your account will be activated after admin verification.',
      user: {
        id: authData.user.id,
        email: authData.user.email
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Registration failed. Please try again.'
    });
  }
});

// ============================================
// STUDENT LOGIN
// ============================================
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Validate email
    const emailRegex = /^[a-zA-Z0-9._%+-]+@(st\.)?tau\.edu\.ng$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Please use a valid TAU student email'
      });
    }

    // Attempt login with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password: password
    });

    if (error) {
      console.error('Login error:', error.message);
      return res.status(401).json({
        error: 'Invalid email or password. Please try again.'
      });
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

    // Check if student is pending verification
    if (studentProfile && studentProfile.status === 'pending') {
      return res.status(403).json({
        error: 'Your account is pending verification by an admin. Please wait for approval.',
        status: 'pending'
      });
    }

    // Check if student is rejected
    if (studentProfile && studentProfile.status === 'rejected') {
      return res.status(403).json({
        error: 'Your account registration was rejected. Please contact support for assistance.',
        status: 'rejected'
      });
    }

    // Check if student is banned
    if (studentProfile && studentProfile.status === 'banned') {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact support.',
        status: 'banned'
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

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: data.user.id,
        email: data.user.email,
        role: role,
        student: studentProfile || null
      },
      session: data.session
    });

  } catch (error) {
    console.error('Login route error:', error);
    res.status(500).json({
      error: 'Login failed. Please try again.'
    });
  }
});

// ============================================
// ADMIN LOGIN (Shared Account)
// ============================================
router.post('/admin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Only allow the specific admin email
    if (email.toLowerCase() !== 'nacos@tau.edu.ng') {
      return res.status(401).json({
        error: 'Invalid admin credentials'
      });
    }

    // Attempt login with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password: password
    });

    if (error) {
      console.error('Admin login error:', error.message);
      return res.status(401).json({
        error: 'Invalid admin credentials'
      });
    }

    // Check if user has admin role
    const { data: adminData, error: adminError } = await supabase
      .from('admin_users')
      .select('*')
      .eq('user_id', data.user.id)
      .single();

    if (adminError || !adminData) {
      return res.status(403).json({
        error: 'Access denied. Admin privileges required.'
      });
    }

    // Log admin login
    await auditLog({
      action: 'admin_login',
      userId: data.user.id,
      details: { email: data.user.email },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Admin login successful',
      user: {
        id: data.user.id,
        email: data.user.email,
        role: adminData.role,
        name: adminData.name
      },
      session: data.session
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      error: 'Admin login failed. Please try again.'
    });
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

    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        role: req.userRole || 'student',
        student: student || null
      }
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      error: 'Verification failed'
    });
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

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Logout failed. Please try again.'
    });
  }
});

// ============================================
// FORGOT PASSWORD
// ============================================
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !validateEmail(email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address'
      });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email.toLowerCase(), {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password.html`
    });

    if (error) {
      console.error('Password reset error:', error);
      // Don't reveal if email exists or not for security
      return res.status(200).json({
        success: true,
        message: 'If your email is registered, you will receive a password reset link.'
      });
    }

    res.json({
      success: true,
      message: 'Password reset link sent to your email.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      error: 'Failed to send reset link. Please try again.'
    });
  }
});

module.exports = router;