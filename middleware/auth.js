// middleware/auth.js
const { supabase } = require('../config/supabase');

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header
 */
const authenticate = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required. Please provide a valid token.'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        error: 'No token provided'
      });
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.error('Token verification failed:', error?.message);
      return res.status(401).json({
        error: 'Invalid or expired token. Please log in again.'
      });
    }

    // Check if user is banned or inactive
    const { data: userStatus, error: statusError } = await supabase
      .from('students')
      .select('status')
      .eq('user_id', user.id)
      .single();

    if (statusError && statusError.code !== 'PGRST116') {
      console.error('Status check error:', statusError);
    }

    if (userStatus?.status === 'banned') {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact support.'
      });
    }

    // Attach user to request object
    req.user = user;
    req.userId = user.id;
    
    // Get user role from database
    const { data: roleData } = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', user.id)
      .single();

    req.userRole = roleData?.role || 'student';

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      error: 'Authentication failed. Please try again.'
    });
  }
};

/**
 * Admin authorization middleware
 * Requires user to have admin role
 */
const requireAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  if (req.userRole !== 'admin' && req.userRole !== 'super_admin') {
    return res.status(403).json({
      error: 'Access denied. Admin privileges required.'
    });
  }

  next();
};

/**
 * Super Admin authorization middleware
 * Requires user to have super_admin role
 */
const requireSuperAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  if (req.userRole !== 'super_admin') {
    return res.status(403).json({
      error: 'Access denied. Super Admin privileges required.'
    });
  }

  next();
};

/**
 * Optional authentication (doesn't require token)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (!error && user) {
        req.user = user;
        req.userId = user.id;
      }
    }
    next();
  } catch (error) {
    // Continue without user
    next();
  }
};

module.exports = {
  authenticate,
  requireAdmin,
  requireSuperAdmin,
  optionalAuth
};