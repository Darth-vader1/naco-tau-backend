const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { errorResponse, successResponse } = require('../utils/helpers');
const { sendBulkEmail, getEmailTemplate, getActiveStudents, sendProfileUpdateReminderEmail, checkAndSendProfileReminders } = require('../services/email');
const { instances: { apiLimiter: broadcastLimiter } } = require('../middleware/rateLimitInstances');

function calculateNextCronRun() {
    const cronDays = [1, 3, 5]; // Mon, Wed, Fri
    const cronHourUtc = 15;
    const cronMinuteUtc = 0;
    
    const now = new Date();
    let candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cronHourUtc, cronMinuteUtc, 0));
    
    for (let i = 0; i < 7; i++) {
        const day = candidate.getUTCDay();
        if (cronDays.includes(day) && candidate > now) {
            return candidate;
        }
        candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
}

/**
 * @route   GET /api/emails/analytics
 * @desc    Get aggregated stats, cron status, daily trends, and sender info
 * @access  Private/Admin
 */
router.get('/analytics', authenticate, requireAdmin, async (req, res) => {
    try {
        const { timeframe = '30d' } = req.query;

        let startDateIso = null;
        const now = new Date();
        if (timeframe === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            startDateIso = startOfDay.toISOString();
        } else if (timeframe === '7d') {
            startDateIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (timeframe === '30d') {
            startDateIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        }

        // 1. Fetch relevant audit logs
        let logsQuery = supabase
            .from('audit_logs')
            .select('id, action, user_id, user_email, details, timestamp')
            .or('action.ilike.%email%,action.ilike.%reminder%')
            .order('timestamp', { ascending: false });

        if (startDateIso) {
            logsQuery = logsQuery.gte('timestamp', startDateIso);
        }

        const { data: emailLogs, error: logErr } = await logsQuery.limit(2000);
        if (logErr) throw logErr;

        // 2. Count breakdown
        let profileReminders = 0;
        let broadcasts = 0;
        let welcomeEmails = 0;
        let ticketEmails = 0;
        let failedEmails = 0;
        let otherEmails = 0;

        const dailyMap = {};
        (emailLogs || []).forEach(log => {
            const act = (log.action || '').toLowerCase();
            const isFailed = act.includes('failed') || act.includes('error');
            if (isFailed) failedEmails++;

            if (act === 'profile_reminder_email_sent') profileReminders++;
            else if (act.includes('broadcast')) broadcasts++;
            else if (act.includes('welcome')) welcomeEmails++;
            else if (act.includes('ticket')) ticketEmails++;
            else otherEmails++;

            const dateStr = log.timestamp ? log.timestamp.split('T')[0] : 'Unknown';
            if (!dailyMap[dateStr]) {
                dailyMap[dateStr] = { date: dateStr, count: 0, reminders: 0, broadcasts: 0, others: 0 };
            }
            dailyMap[dateStr].count++;
            if (act === 'profile_reminder_email_sent') dailyMap[dateStr].reminders++;
            else if (act.includes('broadcast')) dailyMap[dateStr].broadcasts++;
            else dailyMap[dateStr].others++;
        });

        const totalSent = (emailLogs || []).length - failedEmails;
        const successRate = (emailLogs || []).length > 0 
            ? Math.round((totalSent / (emailLogs || []).length) * 100) 
            : 100;

        // 3. Active students profile status & cooldown
        const { data: students } = await supabase
            .from('students')
            .select('id, user_id, email, bio, skills, profile_picture_url, phone, linkedin, github')
            .eq('status', 'active');

        const cooldownHours = 44;
        const cooldownThresholdIso = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
        const { data: recentLogs } = await supabase
            .from('audit_logs')
            .select('user_id, user_email, timestamp')
            .eq('action', 'profile_reminder_email_sent')
            .gte('timestamp', cooldownThresholdIso);

        const recentlyRemindedUserIds = new Set((recentLogs || []).map(l => l.user_id).filter(Boolean));
        const recentlyRemindedEmails = new Set((recentLogs || []).map(l => (l.user_email || '').toLowerCase().trim()).filter(Boolean));

        let completeProfiles = 0;
        let incompleteProfiles = 0;
        let inCooldown = 0;
        let readyToSend = 0;

        (students || []).forEach(s => {
            const emailLower = (s.email || '').toLowerCase().trim();
            const isUnderCooldown = Boolean(
                (s.user_id && recentlyRemindedUserIds.has(s.user_id)) ||
                (emailLower && recentlyRemindedEmails.has(emailLower))
            );

            const missing = [];
            const hasBio = s.bio && String(s.bio).trim().length >= 10;
            let skillsList = [];
            if (Array.isArray(s.skills)) {
                skillsList = s.skills;
            } else if (typeof s.skills === 'string' && s.skills.trim()) {
                try { skillsList = JSON.parse(s.skills); } catch (_) { skillsList = s.skills.split(',').map(x => x.trim()).filter(Boolean); }
            }
            const hasSkills = Array.isArray(skillsList) && skillsList.length > 0;
            const hasPfp = s.profile_picture_url && !s.profile_picture_url.includes('tau_logo');
            const hasPhone = s.phone && String(s.phone).trim().length >= 8;
            const hasSocial = Boolean(s.linkedin || s.github);

            if (!hasPfp) missing.push('Profile Picture');
            if (!hasBio) missing.push('Bio / About Me');
            if (!hasSkills) missing.push('Technical Skills');
            if (!hasSocial) missing.push('LinkedIn or GitHub');
            if (!hasPhone) missing.push('Phone Number');

            if (missing.length < 2) {
                completeProfiles++;
            } else {
                incompleteProfiles++;
                if (isUnderCooldown) inCooldown++;
                else readyToSend++;
            }
        });

        // 4. Calculate next cron run (Mon, Wed, Fri at 15:00 UTC = 16:00 WAT)
        const nextCron = calculateNextCronRun();

        // 5. Daily activity sorted by date ascending for charts
        const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

        const oauthActive = Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.OAUTH_REFRESH_TOKEN);
        const smtpActive = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

        return successResponse(res, {
            summary: {
                totalLogged: (emailLogs || []).length,
                totalSent: Math.max(totalSent, 0),
                profileReminders,
                broadcasts,
                welcomeEmails,
                ticketEmails,
                failedEmails,
                otherEmails,
                successRate
            },
            cronStatus: {
                schedule: '0 15 * * 1,3,5',
                scheduleText: 'Every Monday, Wednesday, & Friday at 4:00 PM WAT',
                nextRunUtc: nextCron.toISOString(),
                lastRunTime: recentLogs && recentLogs.length > 0 ? recentLogs[0].timestamp : null,
                activeStudents: (students || []).length,
                completeProfiles,
                incompleteProfiles,
                inCooldown,
                readyToSend
            },
            typeDistribution: {
                profileReminders,
                broadcasts,
                welcomeEmails,
                ticketEmails,
                otherEmails
            },
            dailyActivity,
            sender: {
                from: process.env.EMAIL_FROM || 'nacos@tau.edu.ng',
                mode: oauthActive ? 'Gmail OAuth2 API' : smtpActive ? 'Standard SMTP' : 'Unconfigured',
                isReady: oauthActive || smtpActive
            }
        });

    } catch (err) {
        console.error('Email analytics error:', err);
        return errorResponse(res, 'Failed to fetch email analytics: ' + err.message, 500, err);
    }
});

/**
 * @route   GET /api/emails/logs
 * @desc    Get paginated email activity logs
 * @access  Private/Admin
 */
router.get('/logs', authenticate, requireAdmin, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
        const offset = (page - 1) * limit;
        const { type, search } = req.query;

        let query = supabase
            .from('audit_logs')
            .select('*', { count: 'exact' })
            .or('action.ilike.%email%,action.ilike.%reminder%')
            .order('timestamp', { ascending: false });

        if (type && type !== 'all') {
            if (type === 'profile_reminder') {
                query = query.eq('action', 'profile_reminder_email_sent');
            } else if (type === 'broadcast') {
                query = query.ilike('action', '%broadcast%');
            } else if (type === 'failed') {
                query = query.ilike('action', '%failed%');
            } else {
                query = query.eq('action', type);
            }
        }

        if (search && search.trim()) {
            const s = search.trim();
            query = query.or(`user_email.ilike.%${s}%,action.ilike.%${s}%`);
        }

        const { data, count, error } = await query.range(offset, offset + limit - 1);
        if (error) throw error;

        return successResponse(res, {
            logs: data || [],
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limit)
            }
        });
    } catch (err) {
        console.error('Email logs error:', err);
        return errorResponse(res, 'Failed to fetch email logs: ' + err.message, 500, err);
    }
});

/**
 * @route   POST /api/emails/test-send
 * @desc    Send a single live test email to verify credentials
 * @access  Private/Admin
 */
router.post('/test-send', authenticate, requireAdmin, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return errorResponse(res, 'Email address is required', 400);
        }

        const mockStudent = {
            name: 'Admin Test Student',
            first_name: 'Admin',
            last_name: 'Tester',
            email: email.trim(),
            matric_no: '24/10MSC000',
            department: 'Computer Science'
        };
        const testMissing = ['Profile Picture', 'Bio / About Me', 'Technical Skills'];
        const result = await sendProfileUpdateReminderEmail({ student: mockStudent, missingFields: testMissing });

        await auditLog({
            action: 'admin_test_email_sent',
            userId: req.userId,
            userEmail: email.trim(),
            details: { target: email.trim(), result },
            ip: req.ip
        });

        return successResponse(res, result, `Test reminder email successfully sent to ${email}`);
    } catch (err) {
        console.error('Test email error:', err);
        return errorResponse(res, 'Failed to send test email: ' + err.message, 500, err);
    }
});

/**
 * @route   POST /api/emails/reset-cooldown
 * @desc    Clear reminder logs so all students can receive reminders again
 * @access  Private/Admin
 */
router.post('/reset-cooldown', authenticate, requireAdmin, async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('audit_logs')
            .delete({ count: 'exact' })
            .eq('action', 'profile_reminder_email_sent');

        if (error) throw error;

        await auditLog({
            action: 'reminder_cooldown_reset',
            userId: req.userId,
            details: { deletedLogsCount: count },
            ip: req.ip
        });

        return successResponse(res, { resetCount: count || 0 }, `Successfully reset cooldown! ${count || 0} reminder log(s) cleared.`);
    } catch (err) {
        console.error('Reset cooldown error:', err);
        return errorResponse(res, 'Failed to reset cooldown: ' + err.message, 500, err);
    }
});

/**
 * @route   POST /api/emails/trigger-reminders
 * @desc    Manually trigger profile reminder scan (live or dry-run)
 * @access  Private/Admin
 */
router.post('/trigger-reminders', authenticate, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 50, 1), 200);
        const dryRun = req.body.dryRun === true;
        const result = await checkAndSendProfileReminders({ dryRun, limit });

        if (!dryRun) {
            await auditLog({
                action: 'profile_reminders_triggered_manual',
                userId: req.userId,
                details: result,
                ip: req.ip
            });
        }

        return successResponse(res, result, dryRun ? 'Reminder preview generated' : 'Reminders dispatched successfully');
    } catch (err) {
        console.error('Trigger reminders error:', err);
        return errorResponse(res, 'Failed to trigger reminders: ' + err.message, 500, err);
    }
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
