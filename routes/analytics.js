// backend/routes/analytics.js
// Analytics & Activity Tracking for Academic Resources, Past Questions, Timetables, and Career Paths
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Helper to sanitize IP address
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// ============================================
// TRACK RESOURCE ACTIVITY (Views, Downloads, Saves)
// ============================================
// Public/OptionalAuth so both authenticated students & guests are tracked
router.post('/track', optionalAuth, async (req, res) => {
  try {
    const {
      resource_type,
      resource_id,
      resource_title,
      course_code,
      action = 'view'
    } = req.body;

    if (!resource_type || !resource_title) {
      return errorResponse(res, 'resource_type and resource_title are required', 400);
    }

    const validTypes = ['past_question', 'academic_resource', 'timetable', 'career_path', 'other'];
    const sanitizedType = validTypes.includes(resource_type) ? resource_type : 'other';

    const validActions = ['view', 'download', 'save'];
    const sanitizedAction = validActions.includes(action) ? action : 'view';

    let studentId = null;
    let studentName = 'Guest Visitor';
    let studentEmail = null;
    let matricNo = null;
    let department = null;
    let level = null;

    if (req.userId) {
      // Fetch student details
      const { data: student } = await supabase
        .from('students_with_current_level')
        .select('id, name, email, matric_no, department, current_level')
        .eq('user_id', req.userId)
        .maybeSingle();

      if (student) {
        studentId = student.id;
        studentName = student.name || 'Student';
        studentEmail = student.email || req.user?.email || null;
        matricNo = student.matric_no || null;
        department = student.department || null;
        level = student.current_level ? parseInt(student.current_level, 10) : null;
      } else {
        // Fallback to basic students table
        const { data: fallbackStudent } = await supabase
          .from('students')
          .select('id, name, email, matric_no, department')
          .eq('user_id', req.userId)
          .maybeSingle();

        if (fallbackStudent) {
          studentId = fallbackStudent.id;
          studentName = fallbackStudent.name || 'Student';
          studentEmail = fallbackStudent.email || req.user?.email || null;
          matricNo = fallbackStudent.matric_no || null;
          department = fallbackStudent.department || null;
        } else if (req.user?.email) {
          studentEmail = req.user.email;
          studentName = req.user.email.split('@')[0];
        }
      }
    }

    const logEntry = {
      user_id: req.userId || null,
      student_id: studentId,
      student_name: studentName,
      student_email: studentEmail,
      matric_no: matricNo,
      department: department,
      level: level,
      resource_type: sanitizedType,
      resource_id: resource_id || null,
      resource_title: String(resource_title).substring(0, 255),
      course_code: course_code ? String(course_code).toUpperCase().trim().substring(0, 32) : null,
      action: sanitizedAction,
      ip_address: getClientIp(req),
      user_agent: req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 255) : null,
      created_at: new Date().toISOString()
    };

    // Insert activity log
    const { data: inserted, error: insertErr } = await supabase
      .from('resource_activity_logs')
      .insert([logEntry])
      .select()
      .maybeSingle();

    if (insertErr) {
      console.warn('[analytics/track] Insert notice:', insertErr.message);
    }

    // Increment download/view count on underlying tables if available
    if (resource_id) {
      (async () => {
        try {
          if (sanitizedType === 'academic_resource' && sanitizedAction === 'download') {
            await supabase.rpc('increment_download_count', { row_id: resource_id }).catch(() => {});
          }
        } catch (_) {}
      })();
    }

    return successResponse(res, { tracked: true, id: inserted?.id }, 'Activity tracked successfully');

  } catch (error) {
    console.error('Track activity error:', error);
    return errorResponse(res, 'Failed to track resource activity', 500, error);
  }
});

// ============================================
// GET ANALYTICS OVERVIEW (Admin Only)
// ============================================
router.get('/overview', authenticate, requireAdmin, async (req, res) => {
  try {
    const { timeframe = '30d' } = req.query;

    let startDate = null;
    const now = new Date();
    if (timeframe === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (timeframe === '7d') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (timeframe === '30d') {
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    let query = supabase.from('resource_activity_logs').select('*');
    if (startDate) {
      query = query.gte('created_at', startDate);
    }

    const { data: records, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    const all = records || [];

    let totalViews = 0;
    let totalDownloads = 0;
    let totalSaves = 0;

    const resourceTypeCounts = {
      past_question: { views: 0, downloads: 0, total: 0 },
      academic_resource: { views: 0, downloads: 0, total: 0 },
      timetable: { views: 0, downloads: 0, total: 0 },
      career_path: { views: 0, saves: 0, total: 0 },
      other: { views: 0, downloads: 0, total: 0 }
    };

    const studentMap = new Map();
    const resourceMap = new Map();
    const departmentMap = new Map();
    const levelMap = new Map();
    const timelineMap = new Map();

    all.forEach(item => {
      const type = item.resource_type || 'other';
      if (!resourceTypeCounts[type]) {
        resourceTypeCounts[type] = { views: 0, downloads: 0, total: 0 };
      }
      resourceTypeCounts[type].total++;

      if (item.action === 'view') {
        totalViews++;
        resourceTypeCounts[type].views = (resourceTypeCounts[type].views || 0) + 1;
      } else if (item.action === 'download') {
        totalDownloads++;
        resourceTypeCounts[type].downloads = (resourceTypeCounts[type].downloads || 0) + 1;
      } else if (item.action === 'save') {
        totalSaves++;
        resourceTypeCounts[type].saves = (resourceTypeCounts[type].saves || 0) + 1;
      }

      // Track unique students
      if (item.matric_no || item.student_email || item.user_id) {
        const key = item.matric_no || item.student_email || item.user_id;
        if (!studentMap.has(key)) {
          studentMap.set(key, {
            name: item.student_name || 'Student',
            matric_no: item.matric_no || 'N/A',
            department: item.department || 'N/A',
            level: item.level || 'N/A',
            views: 0,
            downloads: 0,
            total: 0
          });
        }
        const s = studentMap.get(key);
        s.total++;
        if (item.action === 'download') s.downloads++;
        if (item.action === 'view') s.views++;
      }

      // Track resources
      const resKey = item.resource_title || 'Untitled Resource';
      if (!resourceMap.has(resKey)) {
        resourceMap.set(resKey, {
          title: item.resource_title,
          type: item.resource_type,
          course_code: item.course_code,
          views: 0,
          downloads: 0,
          total: 0
        });
      }
      const r = resourceMap.get(resKey);
      r.total++;
      if (item.action === 'download') r.downloads++;
      if (item.action === 'view') r.views++;

      // Track Department
      if (item.department) {
        const dept = item.department;
        departmentMap.set(dept, (departmentMap.get(dept) || 0) + 1);
      }

      // Track Level
      if (item.level) {
        const lvl = `${item.level} Level`;
        levelMap.set(lvl, (levelMap.get(lvl) || 0) + 1);
      }

      // Timeline (Date: YYYY-MM-DD)
      const dateKey = item.created_at ? item.created_at.split('T')[0] : 'Unknown';
      if (!timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, { date: dateKey, views: 0, downloads: 0, total: 0 });
      }
      const t = timelineMap.get(dateKey);
      t.total++;
      if (item.action === 'view') t.views++;
      if (item.action === 'download') t.downloads++;
    });

    // Top 10 Resources
    const topResources = Array.from(resourceMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Top 10 Active Students
    const topStudents = Array.from(studentMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Timeline sorted ascending
    const timeline = Array.from(timelineMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    // Department & Level arrays
    const byDepartment = Array.from(departmentMap.entries()).map(([department, count]) => ({ department, count }));
    const byLevel = Array.from(levelMap.entries()).map(([level, count]) => ({ level, count }));

    return successResponse(res, {
      summary: {
        total_actions: all.length,
        total_views: totalViews,
        total_downloads: totalDownloads,
        total_saves: totalSaves,
        unique_students_active: studentMap.size,
        unique_resources_engaged: resourceMap.size,
        timeframe
      },
      by_resource_type: resourceTypeCounts,
      top_resources: topResources,
      top_students: topStudents,
      by_department: byDepartment,
      by_level: byLevel,
      timeline
    }, 'Analytics overview retrieved successfully');

  } catch (error) {
    console.error('Analytics overview error:', error);
    return errorResponse(res, 'Failed to fetch analytics overview', 500, error);
  }
});

// ============================================
// GET ACTIVITY LOGS (Paginated & Filterable)
// ============================================
router.get('/logs', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      resource_type,
      action,
      department,
      level,
      search,
      start_date,
      end_date
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('resource_activity_logs')
      .select('*', { count: 'exact' });

    if (resource_type && resource_type !== 'all') {
      query = query.eq('resource_type', resource_type);
    }

    if (action && action !== 'all') {
      query = query.eq('action', action);
    }

    if (department && department !== 'all') {
      query = query.eq('department', department);
    }

    if (level && level !== 'all') {
      query = query.eq('level', parseInt(level, 10));
    }

    if (start_date) {
      query = query.gte('created_at', start_date);
    }

    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    if (search && search.trim()) {
      const term = search.trim();
      query = query.or(
        `student_name.ilike.%${term}%,` +
        `matric_no.ilike.%${term}%,` +
        `resource_title.ilike.%${term}%,` +
        `course_code.ilike.%${term}%,` +
        `student_email.ilike.%${term}%`
      );
    }

    const { data: logs, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (error) throw error;

    return successResponse(res, {
      logs: logs || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limitNum)
      }
    }, 'Activity logs retrieved successfully');

  } catch (error) {
    console.error('Fetch activity logs error:', error);
    return errorResponse(res, 'Failed to fetch activity logs', 500, error);
  }
});

// ============================================
// EXPORT ACTIVITY LOGS TO CSV (Admin Only)
// ============================================
router.get('/export', authenticate, requireAdmin, async (req, res) => {
  try {
    const { resource_type, action, start_date, end_date } = req.query;

    let query = supabase
      .from('resource_activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (resource_type && resource_type !== 'all') query = query.eq('resource_type', resource_type);
    if (action && action !== 'all') query = query.eq('action', action);
    if (start_date) query = query.gte('created_at', start_date);
    if (end_date) query = query.lte('created_at', end_date);

    const { data: logs, error } = await query;
    if (error) throw error;

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const clean = String(str).replace(/"/g, '""');
      return `"${clean}"`;
    };

    const headers = [
      'Timestamp',
      'Action',
      'Resource Category',
      'Resource Title',
      'Course Code',
      'Student Name',
      'Matric No',
      'Department',
      'Level',
      'Student Email',
      'IP Address'
    ];

    const rows = (logs || []).map(item => [
      item.created_at,
      item.action,
      item.resource_type,
      item.resource_title,
      item.course_code || '',
      item.student_name || 'Guest',
      item.matric_no || '',
      item.department || '',
      item.level || '',
      item.student_email || '',
      item.ip_address || ''
    ].map(escapeCsv).join(','));

    const csvContent = [headers.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nacos-resource-analytics-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvContent);

  } catch (error) {
    console.error('Export analytics error:', error);
    return errorResponse(res, 'Failed to export analytics data', 500, error);
  }
});

module.exports = router;
