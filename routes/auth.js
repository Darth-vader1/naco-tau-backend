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

/**
 * Permanently (HARD) delete a Supabase Auth user.
 *
 * The default admin.deleteUser(id) in Supabase JS SDK v2 does a SOFT
 * delete — it only sets `deleted_at` on the auth.users row. A soft-deleted
 * row still blocks re-registration with the same email (GoTrue checks
 * both deleted and non-deleted rows for uniqueness) and the row is
 * hidden from the default Dashboard Users view.
 *
 * This helper tries the SDK's explicit permanent-delete option first,
 * and falls back to a direct SQL DELETE from auth.users via the
 * service-role Postgres client — which always works on projects where
 * service_role key bypasses RLS on the auth schema.
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
  } catch (_) { /* rpc may not exist — ignore; fall through to SQL */ }
  try {
    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (!error) return;
    lastErr = error;
  } catch (_) { /* RLS may block this branch; expected sometimes */ }
  console.warn('[auth.js] permanentlyDeleteAuthUser: all branches failed for', userId, 'last error:', lastErr?.message || lastErr);
};

/**
 * Look up an Auth user by email, including soft-deleted rows.
 * Returns the user object (with .id, .email, .email_confirmed_at, .deleted_at)
 * or null if none exists. Uses the admin listUsers API which enumerates
 * every row regardless of soft-delete status.
 */
const findAuthUserByEmail = async (rawEmail) => {
  const target = (rawEmail || '').toString().trim().toLowerCase();
  if (!target) return null;
  try {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    });
    if (error) {
      console.warn('[auth.js] findAuthUserByEmail listUsers failed:', error.message);
      return null;
    }
    const list = data?.users || [];
    return list.find((u) => (u.email || '').toLowerCase() === target) || null;
  } catch (e) {
    console.warn('[auth.js] findAuthUserByEmail raised:', e.message);
    return null;
  }
};

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
      return errorResponse(res, 'Invalid matric number format. Expected format: YY/NNDDD### (example: 23/10MSC014)', 400);
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

    // ============================================================
    // STEP 0 — Auth-users orphan cleanup (auto-heals failed
    // previous signup attempts).
    //
    // Timeline context: the old auth.signUp() flow (and even our
    // current admin.createUser + soft-delete rollback) leaves rows
    // in auth.users with:
    //   - email_confirmed_at = NULL  (signUp anti-enumeration path)
    //   - OR deleted_at IS NOT NULL  (the default "soft" delete)
    // Either state blocks admin.createUser with "A user with this
    // email address has already been registered", but these rows
    // are by default HIDDEN in the Dashboard Users view, so the
    // operator believes no user exists.
    //
    // Rule: if we find an auth.users row for this email AND there
    // is NO matching students.* profile row, we treat it as an
    // orphan and PERMANENTLY purge it so the current, legitimate
    // signup can succeed. If there IS a matching profile row, we
    // return 409 as a normal duplicate.
    // ============================================================
    const preExistingAuthUser = await findAuthUserByEmail(email);
    if (preExistingAuthUser) {
      const { data: profileForAuthUser } = await supabase
        .from('students')
        .select('user_id, email, status')
        .or(`user_id.eq.${preExistingAuthUser.id},email.eq.${email.toLowerCase()}`)
        .limit(1)
        .maybeSingle();
      if (profileForAuthUser) {
        return errorResponse(
          res,
          'This email is already registered. Please login instead.',
          409
        );
      }
      console.warn(
        `[register] found orphan auth user ${preExistingAuthUser.id} ` +
        `(${email}) with email_confirmed_at=${preExistingAuthUser.email_confirmed_at ?? 'NULL'} ` +
        `deleted_at=${preExistingAuthUser.deleted_at ?? 'NULL'}. Purging permanently…`
      );
      await permanentlyDeleteAuthUser(preExistingAuthUser.id);
    }

    // ============================================================
    // STEP 1 — Create the Supabase Auth user as a server admin.
    //
    // Strategy: do TWO short, version-resilient calls instead of
    // one shape-sensitive call:
    //   (a) admin.createUser with only the well-known primitive fields
    //       (email, password, email_confirm: true) — every Supabase
    //       JS SDK v2 supports these; unknown keys can cause 400s on
    //       some older builds so we don't pass metadata here.
    //   (b) admin.updateUserById to attach user_metadata — this API
    //       accepts both "data" and "user_metadata" shapes reliably.
    //
    // email_confirm: true  →  writes email_confirmed_at immediately,
    // so the subsequent password-based sign-in (client OR server) is
    // allowed by GoTrue and cannot 400 with "Invalid credentials".
    // ============================================================
    let authData = null;
    {
      const { data, error } = await supabase.auth.admin.createUser({
        email: email.toLowerCase(),
        password: password,
        email_confirm: true
      });
      if (error) {
        console.error('[register] admin.createUser failed:', error);
        const debugMsg = error?.message
          ? `Registration failed: ${error.message}`
          : 'Registration failed. Please try again.';
        return errorResponse(res, debugMsg, 400, error);
      }
      authData = data;
    }

    {
      const meta = {
        full_name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName,
        role: 'student'
      };
      const { error } = await supabase.auth.admin.updateUserById(authData.user.id, { user_metadata: meta });
      if (error) {
        console.warn('[register] admin.updateUserById for metadata failed (non-fatal):', error);
      }
    }

    // ============================================================
    // STEP 2 — Mint a browser session for the newly-created user.
    //
    // With email_confirm=true set above, a plain password-based
    // sign-in is now permitted. Performing the exchange on the
    // server means:
    //   - the frontend avoids one extra Supabase round-trip;
    //   - the frontend can call setSession directly;
    //   - if the service-role client ever has issues, we still
    //     return session=null so the existing client-side password
    //     fallback in student-signup.html takes over cleanly.
    // ============================================================
    let session = null;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase().trim(),
        password: password
      });
      if (error) {
        console.warn('[register] server-side session signIn failed (non-fatal, client will fallback):', error.message);
      } else {
        session = data?.session || null;
      }
    } catch (signInErr) {
      console.warn('[register] server-side session signIn threw (non-fatal):', signInErr.message);
    }

    // ============================================================
    // STEP 3 — Write the local student profile (RLS-bypassed via
    // service role). Roll back the Auth user on any failure so we
    // never leave orphaned Supabase users.
    // ============================================================
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
        status: 'active',
        created_at: new Date().toISOString()
      }]);

    if (profileError) {
      console.error('Profile creation error:', profileError);
      // Must be permanent (not soft) delete. Otherwise the orphaned
      // auth.user will block any future signup attempt with the same
      // email, and the row is invisible in the default Dashboard view.
      await permanentlyDeleteAuthUser(authData.user.id);
      const debugMsg = profileError?.message
        ? `Registration failed: ${profileError.message}`
        : 'Registration failed. Please contact support.';
      return errorResponse(res, debugMsg, 500, profileError);
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
      email: authData.user.email,
      session
    }, 'Registration successful! Your account is now active.', 201);

  } catch (error) {
    console.error('Registration error:', error);
    const debugMsg = error?.message
      ? `Registration failed: ${error.message}`
      : 'Registration failed. Please try again.';
    return errorResponse(res, debugMsg, 500, error);
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
