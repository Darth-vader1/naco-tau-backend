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

function formatTargetAudience(raw) {
    if (!raw || raw === 'all') return 'All Active Students';
    let obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch (_) { return raw; }
    }
    const list = obj.audiences || obj.combos || obj.targetCombos || [];
    if (Array.isArray(list) && list.length > 0) {
        return list.map(item => {
            const lvl = item.level ? `${item.level} Level` : '';
            const dept = item.department || '';
            if (lvl && dept) return `${lvl} • ${dept}`;
            if (lvl) return `${lvl} (All Departments)`;
            if (dept) return dept;
            return 'All Students';
        }).join(', ');
    }
    return typeof obj === 'string' ? obj : 'All Active Students';
}

/**
 * Helper to fetch and unify email dispatch events from notifications and audit_logs
 */
async function getUnifiedEmailEvents({ startDateIso = null } = {}) {
    // 1. Fetch from notifications table (bulk broadcasts, past questions, timetables, events, etc.)
    let notifsQuery = supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false });

    if (startDateIso) {
        notifsQuery = notifsQuery.gte('created_at', startDateIso);
    }
    const { data: notifs } = await notifsQuery;

    // 2. Fetch from audit_logs (reminders, signups, tickets, tests)
    let logsQuery = supabase
        .from('audit_logs')
        .select('*')
        .or('action.ilike.%email%,action.ilike.%reminder%,action.eq.student_registration,action.eq.welcome_email_sent,action.eq.event_ticket_email_sent')
        .order('timestamp', { ascending: false });

    if (startDateIso) {
        logsQuery = logsQuery.gte('timestamp', startDateIso);
    }
    const { data: logs } = await logsQuery;

    const events = [];

    (notifs || []).forEach(n => {
        const subj = n.subject || 'Broadcast';
        const subjLower = subj.toLowerCase();
        let category = 'broadcast';
        let categoryLabel = '📢 Broadcast';

        if (subjLower.includes('past question')) {
            category = 'past_question';
            categoryLabel = '📚 Past Question';
        } else if (subjLower.includes('timetable')) {
            category = 'timetable_resource';
            categoryLabel = '📅 Timetable';
        } else if (subjLower.includes('resource') || subjLower.includes('academic resource')) {
            category = 'timetable_resource';
            categoryLabel = '📖 Academic Resource';
        } else if (subjLower.includes('event')) {
            category = 'event_hackathon';
            categoryLabel = '🎉 Event';
        } else if (subjLower.includes('hackathon')) {
            category = 'event_hackathon';
            categoryLabel = '🏆 Hackathon';
        } else if (subjLower.includes('career')) {
            category = 'broadcast';
            categoryLabel = '🚀 Career Roadmap';
        }

        const successCount = n.success_count || 0;
        const totalTarget = n.recipient_count || 0;
        const isFailed = (n.error_count > 0 && successCount === 0);

        const cleanAudience = formatTargetAudience(n.target_filter);

        events.push({
            id: n.id,
            action: `notification_${category}`,
            category,
            categoryLabel,
            subject: subj,
            recipient: `${successCount} / ${totalTarget} students`,
            recipientEmail: null,
            targetAudience: cleanAudience,
            sentCount: successCount,
            errorCount: n.error_count || 0,
            status: isFailed ? 'failed' : 'delivered',
            timestamp: n.created_at,
            source: 'notification',
            details: `Target: ${cleanAudience}`
        });
    });

    (logs || []).forEach(l => {
        const act = l.action || '';
        if (act === 'student_registration' || act === 'welcome_email_sent') {
            const email = l.user_email || l.details?.email || 'New student';
            const name = `${l.details?.firstName || ''} ${l.details?.lastName || ''}`.trim() || l.details?.name || 'Student';
            const matric = l.details?.matricNo || l.details?.matric_no || null;
            events.push({
                id: l.id,
                action: act,
                category: 'sign_up',
                categoryLabel: '👤 Welcome & Sign-Up',
                subject: `🎉 Welcome to NACOS TAU, ${name}! Your account is active`,
                recipient: email,
                recipientEmail: email,
                matricNo: matric,
                sentCount: 1,
                errorCount: 0,
                status: 'delivered',
                timestamp: l.timestamp,
                source: 'audit_log',
                details: 'Account activated for new student member'
            });
        } else if (act === 'profile_reminder_email_sent') {
            let rawDetails = {};
            if (typeof l.details === 'object' && l.details) {
                rawDetails = l.details;
            } else if (typeof l.details === 'string') {
                try { rawDetails = JSON.parse(l.details); } catch(_) {}
            }
            const matric = rawDetails.matric_no || l.details?.matric_no || null;
            const missingList = Array.isArray(rawDetails.missing_fields)
                ? rawDetails.missing_fields
                : (typeof rawDetails.missing_fields === 'string' ? [rawDetails.missing_fields] : []);

            events.push({
                id: l.id,
                action: act,
                category: 'profile_reminder',
                categoryLabel: '⏰ Profile Reminder',
                subject: 'Complete Your NACOS TAU Student Profile',
                recipient: l.user_email || 'Student',
                recipientEmail: l.user_email,
                matricNo: matric,
                missingFields: missingList,
                sentCount: 1,
                errorCount: 0,
                status: 'delivered',
                timestamp: l.timestamp,
                source: 'audit_log',
                details: missingList.length > 0 ? `Missing: ${missingList.join(', ')}` : 'Profile completion reminder'
            });
        } else if (act === 'admin_test_email_sent') {
            events.push({
                id: l.id,
                action: act,
                category: 'test_email',
                categoryLabel: '🧪 Test Dispatch',
                subject: 'Profile Reminder Email Test',
                recipient: l.user_email || l.details?.target || 'Admin',
                recipientEmail: l.user_email,
                sentCount: 1,
                errorCount: 0,
                status: 'delivered',
                timestamp: l.timestamp,
                source: 'audit_log',
                details: 'Admin test dispatch'
            });
        } else if (act === 'event_ticket_email_sent') {
            events.push({
                id: l.id,
                action: act,
                category: 'event_hackathon',
                categoryLabel: '🎫 Event Ticket',
                subject: `🎟️ Ticket Confirmed: ${l.details?.event_title || 'NACOS Event'}`,
                recipient: l.user_email || 'Student',
                recipientEmail: l.user_email,
                sentCount: 1,
                errorCount: 0,
                status: 'delivered',
                timestamp: l.timestamp,
                source: 'audit_log',
                details: `Ticket: ${l.details?.ticket_number || 'N/A'}`
            });
        } else if (act.toLowerCase().includes('failed') || act.toLowerCase().includes('error')) {
            events.push({
                id: l.id,
                action: act,
                category: 'failed',
                categoryLabel: '❌ Delivery Error',
                subject: l.details?.subject || 'Email Dispatch Failure',
                recipient: l.user_email || 'Unknown',
                recipientEmail: l.user_email,
                sentCount: 0,
                errorCount: 1,
                status: 'failed',
                timestamp: l.timestamp,
                source: 'audit_log',
                details: typeof l.details === 'object' ? JSON.stringify(l.details) : String(l.details || '')
            });
        }
    });

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return events;
}

/**
 * @route   GET /api/emails/analytics
 * @desc    Get aggregated stats, cron status, daily trends, and sender info across all email systems
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

        // 1. Fetch unified email events
        const events = await getUnifiedEmailEvents({ startDateIso });

        let totalDelivered = 0;
        let pastQuestions = 0;
        let signUps = 0;
        let profileReminders = 0;
        let timetablesResources = 0;
        let eventsHackathons = 0;
        let generalBroadcasts = 0;
        let failedEmails = 0;

        const dailyMap = {};

        events.forEach(e => {
            totalDelivered += e.sentCount;
            failedEmails += e.errorCount;

            if (e.category === 'past_question') pastQuestions += e.sentCount;
            else if (e.category === 'sign_up') signUps += e.sentCount;
            else if (e.category === 'profile_reminder') profileReminders += e.sentCount;
            else if (e.category === 'timetable_resource') timetablesResources += e.sentCount;
            else if (e.category === 'event_hackathon') eventsHackathons += e.sentCount;
            else if (e.category === 'broadcast') generalBroadcasts += e.sentCount;

            const dateStr = e.timestamp ? e.timestamp.split('T')[0] : 'Unknown';
            if (!dailyMap[dateStr]) {
                dailyMap[dateStr] = {
                    date: dateStr,
                    count: 0,
                    pastQuestions: 0,
                    signUps: 0,
                    reminders: 0,
                    broadcasts: 0
                };
            }
            dailyMap[dateStr].count += e.sentCount;
            if (e.category === 'past_question') dailyMap[dateStr].pastQuestions += e.sentCount;
            else if (e.category === 'sign_up') dailyMap[dateStr].signUps += e.sentCount;
            else if (e.category === 'profile_reminder') dailyMap[dateStr].reminders += e.sentCount;
            else dailyMap[dateStr].broadcasts += e.sentCount;
        });

        const totalAttempts = totalDelivered + failedEmails;
        const successRate = totalAttempts > 0 
            ? Math.round((totalDelivered / totalAttempts) * 100) 
            : 100;

        // 2. Active students profile status & cooldown
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

        // 3. Calculate next cron run (Mon, Wed, Fri at 15:00 UTC = 16:00 WAT)
        const nextCron = calculateNextCronRun();

        // 4. Daily activity sorted by date ascending for charts
        const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

        const oauthActive = Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.OAUTH_REFRESH_TOKEN);
        const smtpActive = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

        return successResponse(res, {
            summary: {
                totalDelivered,
                pastQuestions,
                signUps,
                profileReminders,
                timetablesResources,
                eventsHackathons,
                broadcasts: generalBroadcasts + timetablesResources + eventsHackathons,
                failedEmails,
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
                pastQuestions,
                signUps,
                profileReminders,
                broadcasts: generalBroadcasts + timetablesResources + eventsHackathons
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
 * @desc    Get paginated email activity logs across past questions, sign-ups, reminders, and broadcasts
 * @access  Private/Admin
 */
router.get('/logs', authenticate, requireAdmin, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
        const offset = (page - 1) * limit;
        const { type, search } = req.query;

        // Fetch all unified events
        let events = await getUnifiedEmailEvents();

        // Filter by type
        if (type && type !== 'all') {
            if (type === 'past_question') {
                events = events.filter(e => e.category === 'past_question');
            } else if (type === 'sign_up') {
                events = events.filter(e => e.category === 'sign_up');
            } else if (type === 'profile_reminder') {
                events = events.filter(e => e.category === 'profile_reminder');
            } else if (type === 'broadcast') {
                events = events.filter(e => e.category === 'broadcast' || e.category === 'timetable_resource' || e.category === 'event_hackathon');
            } else if (type === 'failed') {
                events = events.filter(e => e.status === 'failed');
            }
        }

        // Filter by search term
        if (search && search.trim()) {
            const s = search.trim().toLowerCase();
            events = events.filter(e => 
                (e.subject && e.subject.toLowerCase().includes(s)) ||
                (e.recipient && e.recipient.toLowerCase().includes(s)) ||
                (e.recipientEmail && e.recipientEmail.toLowerCase().includes(s)) ||
                (e.categoryLabel && e.categoryLabel.toLowerCase().includes(s)) ||
                (e.details && e.details.toLowerCase().includes(s))
            );
        }

        const total = events.length;
        const paginated = events.slice(offset, offset + limit);

        return successResponse(res, {
            logs: paginated,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Email logs error:', err);
        return errorResponse(res, 'Failed to fetch email logs: ' + err.message, 500, err);
    }
});

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
