const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { errorResponse, successResponse } = require('../utils/helpers');
const { sendBulkEmail, getEmailTemplate, getActiveStudents } = require('../services/email');
const { rateLimit } = require('express-rate-limit');

// Rate limiter specifically for broadcasting to prevent abuse
const broadcastLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 10, // Limit each IP to 10 broadcast requests per windowMs
    message: { error: 'Too many broadcasts sent from this IP, please try again after an hour' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * @route   POST /api/emails/preview-recipients
 * @desc    Preview recipient count and list matching combo filter
 * @access  Private/Admin
 */
router.post('/preview-recipients', authenticate, requireAdmin, async (req, res) => {
    try {
        let targetFilter = req.body.targetFilter || null;
        if (!targetFilter) {
            const audiences = req.body.audiences || req.body.combos;
            const levels = req.body.levels || (req.body.level ? [req.body.level] : null);
            const departments = req.body.departments || (req.body.department ? [req.body.department] : null);
            if (audiences || levels || departments) {
                targetFilter = { audiences, levels, departments };
            }
        }

        const students = await getActiveStudents(targetFilter);
        return successResponse(res, {
            count: students.length,
            targetFilter: targetFilter || 'all',
            recipients: students.slice(0, 50).map(s => ({
                name: s.name,
                email: s.email,
                matric_no: s.matric_no,
                level: s.current_level || s.year_of_study || 'N/A',
                department: s.department || s.course || 'N/A'
            }))
        }, `Found ${students.length} matching student(s)`);
    } catch (error) {
        console.error('Error previewing recipients:', error);
        return errorResponse(res, 'Failed to preview recipients', 500, error);
    }
});

/**
 * @route   POST /api/emails/broadcast
 * @desc    Send a bulk email to active students (optionally targeted by combo)
 * @access  Private/Admin
 */
router.post('/broadcast', authenticate, requireAdmin, broadcastLimiter, async (req, res) => {
    try {
        const { type, subject, message, link, title } = req.body;

        if (!type || !subject) {
            return errorResponse(res, 'Missing required fields: type and subject are required.', 400);
        }

        // Parse target combo filter
        let targetFilter = req.body.targetFilter || null;
        if (!targetFilter) {
            const audiences = req.body.audiences || req.body.combos;
            const levels = req.body.levels || (req.body.level ? [req.body.level] : null);
            const departments = req.body.departments || (req.body.department ? [req.body.department] : null);
            if (audiences || levels || departments) {
                targetFilter = { audiences, levels, departments };
            }
        }

        // Validate template type
        const validTypes = ['new_resource', 'new_event', 'announcement', 'new_past_question', 'new_timetable', 'new_career_path', 'new_hackathon'];
        if (!validTypes.includes(type)) {
            return errorResponse(res, `Invalid email template type. Allowed: ${validTypes.join(', ')}`, 400);
        }

        // Prepare template data based on type
        let templateData = { ...req.body };
        if (type === 'announcement') {
            templateData = { title: title || subject, message, link };
        } else if (type === 'new_resource') {
            templateData = { title: title || subject, description: message || req.body.description, course: req.body.course, resource_type: req.body.resource_type, semester: req.body.semester, author: req.body.author };
        } else if (type === 'new_event') {
            templateData = { title: title || subject, description: message || req.body.description, date: req.body.date, time: req.body.time, location: req.body.location, event_type: req.body.event_type, requires_payment: req.body.requires_payment, payment_amount: req.body.payment_amount };
        } else if (type === 'new_past_question') {
            templateData = { title: title || req.body.title, course_code: req.body.course_code, course_name: req.body.course_name, level: req.body.level, semester: req.body.semester, academic_session: req.body.academic_session || req.body.year };
        } else if (type === 'new_timetable') {
            templateData = { title: title || req.body.title, department: req.body.department, level: req.body.level, semester: req.body.semester, academic_session: req.body.academic_session, version: req.body.version, description: message || req.body.description };
        } else if (type === 'new_career_path') {
            templateData = { title: title || req.body.title, category: req.body.category, description: message || req.body.description, skills: req.body.skills, tools: req.body.tools, salary_range: req.body.salary_range };
        } else if (type === 'new_hackathon') {
            templateData = { title: title || req.body.title, tagline: req.body.tagline, description: message || req.body.description, event_type: req.body.event_type, mode: req.body.mode, prize_pool: req.body.prize_pool, start_date: req.body.start_date, end_date: req.body.end_date, registration_deadline: req.body.registration_deadline, location: req.body.location };
        }

        // Generate HTML from template
        const html = getEmailTemplate(type, templateData);
        
        // Start bulk email job in background
        sendBulkEmail({
            subject,
            html,
            text: message || templateData.description || subject,
            targetFilter
        })
            .then(result => {
                console.log('✅ Bulk email broadcast completed:', result);
                
                // Audit the action
                auditLog({
                    action: 'email_broadcast',
                    userId: req.user.id,
                    details: { subject, type, targetFilter: targetFilter || 'all', stats: result }
                });
            })
            .catch(err => {
                console.error('❌ Bulk email broadcast failed:', err);
                
                auditLog({
                    action: 'email_broadcast_failed',
                    userId: req.user.id,
                    details: { subject, type, targetFilter: targetFilter || 'all', error: err.message }
                });
            });

        return successResponse(res, 'Broadcast initiated successfully. Emails are being sent in the background.', {
            subject,
            type,
            targetFilter: targetFilter || 'all'
        });
        
    } catch (error) {
        console.error('Error initiating broadcast:', error);
        return errorResponse(res, 'Failed to initiate broadcast', 500, error);
    }
});

module.exports = router;
