// backend/services/email.js
const nodemailer = require('nodemailer');
const { supabase } = require('../config/supabase');

// ============================================
// INITIALIZE NODEMAILER (SMTP)
// ============================================

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'nacos@tau.edu.ng';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://nacosportal.vercel.app').replace(/\/$/, '');

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const OAUTH_REFRESH_TOKEN = process.env.OAUTH_REFRESH_TOKEN;

let transporter = null;

if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REFRESH_TOKEN && SMTP_USER) {
    // USE GMAIL API (OAUTH2) - Bypasses Render SMTP blocking
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            type: 'OAuth2',
            user: SMTP_USER,
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
            refreshToken: OAUTH_REFRESH_TOKEN
        }
    });
    console.log('✅ Gmail API (OAuth2) email provider initialized');
} else if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    // FALLBACK TO STANDARD SMTP
    transporter = nodemailer.createTransport({
        pool: true,
        maxConnections: 1,
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: String(SMTP_PORT) === '465',
        family: 4,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
        },
    });
    console.log('✅ Standard SMTP email provider initialized');
} else {
    console.log('⚠️ Email credentials not fully set, email sending disabled');
}

// ============================================
// SEND SINGLE / BATCH EMAIL
// ============================================

async function getGmailAccessToken() {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            refresh_token: OAUTH_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        })
    });
    const data = await response.json();
    if (!data.access_token) throw new Error('Failed to generate Gmail Access Token: ' + JSON.stringify(data));
    return data.access_token;
}

async function sendEmail({ to, bcc, subject, html, text }) {
    try {
        const mailOptions = {
            from: `NACOS TAU <${EMAIL_FROM}>`,
            subject: subject,
            html: html,
            text: text || (html ? html.replace(/<[^>]*>/g, '') : ''),
        };

        if (bcc) {
            mailOptions.to = EMAIL_FROM;
            mailOptions.bcc = Array.isArray(bcc) ? bcc : [bcc];
        } else if (to) {
            mailOptions.to = Array.isArray(to) ? to.join(', ') : to;
        }

        const isOAuth = OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REFRESH_TOKEN;

        if (!transporter && !isOAuth) {
            console.log('⚠️ Email not sent - SMTP/OAuth not initialized');
            return { success: false, error: 'Email Provider not initialized' };
        }

        let info;
        const recipientCount = bcc ? (Array.isArray(bcc) ? bcc.length : 1) : (Array.isArray(to) ? to.length : 1);

        if (isOAuth) {
            // 1. Generate Raw MIME string using a dummy Nodemailer compiler
            const compiler = nodemailer.createTransport({ streamTransport: true });
            const mailObj = await compiler.sendMail(mailOptions);
            const chunks = [];
            for await (const chunk of mailObj.message) {
                chunks.push(chunk);
            }
            const rawMessage = Buffer.concat(chunks).toString('base64url'); // Base64URL required by Google API

            // 2. Fetch fresh Access Token
            const accessToken = await getGmailAccessToken();

            // 3. Send over HTTPS (Bypasses Port 465/587 completely!)
            const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: rawMessage })
            });
            
            const result = await response.json();
            if (!response.ok) throw new Error('Gmail API Error: ' + JSON.stringify(result));
            
            info = { messageId: result.id };
        } else {
            // Standard SMTP Fallback
            info = await transporter.sendMail(mailOptions);
        }

        console.log(`✅ Email sent to ${recipientCount} recipient(s) [ID: ${info.messageId}]`);
        return { success: true, data: info };

    } catch (error) {
        console.error('❌ Email send error:', error);
        throw error;
    }
}

// ============================================
// STUDENT FILTERING & TARGETING HELPERS
// ============================================

/**
 * Normalizes level representation into standard '100', '200', '300', '400'.
 * Handles numbers (1, 2, 3, 4, 100, 200...) and strings ("300L", "300 Level", "year 3").
 */
function normalizeLevel(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).toLowerCase().replace(/level|lvl|year/gi, '').trim();
    if (str === '1' || str === '100') return '100';
    if (str === '2' || str === '200') return '200';
    if (str === '3' || str === '300') return '300';
    if (str === '4' || str === '400') return '400';
    const match = str.match(/(100|200|300|400)/);
    return match ? match[1] : str;
}

/**
 * Normalizes department string into canonical departmental names.
 */
function normalizeDepartment(val) {
    if (!val) return '';
    const str = String(val).toLowerCase().trim();
    if (str.includes('software') || str === 'se' || str === 'sen') return 'Software Engineering';
    if (str.includes('computer') || str === 'cs' || str === 'csc') return 'Computer Science';
    if (str.includes('cyber')) return 'Cybersecurity';
    if (str.includes('info') || str === 'it') return 'Information Technology';
    return val.trim();
}

/**
 * Checks if a single student record matches a specific audience combo or filter.
 *
 * targetFilter can be:
 * - null / undefined / 'all' -> matches everyone
 * - Object:
 *    - audiences / combos: array of combo objects/strings:
 *        [ { level: '300', department: 'Computer Science' }, { level: '200', department: 'Software Engineering' } ]
 *        or ["300 Computer Science", "200 Software Engineering", "300 CS", "200 SE"]
 *    - levels: array of strings/numbers or single level: ['300', '200']
 *    - departments: array of strings or single department: ['Computer Science']
 */
function matchesTargetFilter(student, targetFilter) {
    if (!targetFilter || targetFilter === 'all') return true;

    const studentLevel = normalizeLevel(student.current_level || student.year_of_study || student.level);
    const studentDept = normalizeDepartment(student.department || student.course);

    // 1. Combo array (audiences / combos / targetCombos)
    const audiences = targetFilter.audiences || targetFilter.combos || targetFilter.targetCombos;
    if (Array.isArray(audiences) && audiences.length > 0) {
        return audiences.some(item => {
            if (!item) return false;

            let targetLevel = null;
            let targetDept = null;

            if (typeof item === 'object') {
                targetLevel = normalizeLevel(item.level);
                targetDept = item.department ? normalizeDepartment(item.department) : null;
            } else if (typeof item === 'string') {
                targetLevel = normalizeLevel(item);
                targetDept = normalizeDepartment(item);
            }

            const levelMatches = !targetLevel || targetLevel === studentLevel;
            const deptMatches = !targetDept || targetDept === studentDept;

            return levelMatches && deptMatches;
        });
    }

    // 2. Direct levels & departments filtering
    const rawLevels = targetFilter.levels || (targetFilter.level ? [targetFilter.level] : null);
    const rawDepts = targetFilter.departments || (targetFilter.department ? [targetFilter.department] : null);

    const targetLevels = Array.isArray(rawLevels) ? rawLevels.map(normalizeLevel).filter(Boolean) : null;
    const targetDepts = Array.isArray(rawDepts) ? rawDepts.map(normalizeDepartment).filter(Boolean) : null;

    const levelMatches = !targetLevels || targetLevels.length === 0 || targetLevels.includes(studentLevel);
    const deptMatches = !targetDepts || targetDepts.length === 0 || targetDepts.includes(studentDept);

    return levelMatches && deptMatches;
}

// ============================================
// GET ALL ACTIVE STUDENTS (WITH OPTIONAL FILTER)
// ============================================

async function getActiveStudents(targetFilter = null) {
    try {
        // Query from view if available, fallback to students table
        let queryResult = await supabase
            .from('students_with_current_level')
            .select('email, name, matric_no, user_id, department, course, current_level, year_of_study, status')
            .or('status.eq.active,status.is.null');

        if (queryResult.error) {
            // Fallback to students table directly
            queryResult = await supabase
                .from('students')
                .select('email, name, matric_no, user_id, department, course, year_of_study, status')
                .or('status.eq.active,status.is.null');
        }

        if (queryResult.error) throw queryResult.error;

        const rawList = queryResult.data || [];

        // Ensure valid unique email addresses
        const seen = new Set();
        const valid = [];
        for (const s of rawList) {
            if (s && s.email && s.email.includes('@')) {
                const cleanEmail = s.email.toLowerCase().trim();
                if (!seen.has(cleanEmail)) {
                    seen.add(cleanEmail);
                    valid.push(s);
                }
            }
        }

        // Apply target filter if provided
        if (targetFilter && targetFilter !== 'all') {
            const filtered = valid.filter(student => matchesTargetFilter(student, targetFilter));
            console.log(`📊 Filtered active students: ${filtered.length}/${valid.length} matched criteria`, targetFilter);
            return filtered;
        }

        console.log(`📊 Found ${valid.length} active students for broadcast`);
        return valid;
    } catch (error) {
        console.error('❌ Get students error:', error);
        return [];
    }
}

// ============================================
// SEND BULK EMAIL TO STUDENTS (BCC BATCHES)
// ============================================

async function sendBulkEmail({ subject, html, text, targetFilter = null }) {
    try {
        const students = await getActiveStudents(targetFilter);

        if (students.length === 0) {
            console.log('⚠️ No active students matched the target criteria');
            return { success: true, message: 'No students matched target criteria', count: 0 };
        }

        const emails = students.map(s => s.email.trim()).filter(Boolean);
        console.log(`📧 Broadcasting to ${emails.length} students (Target: ${JSON.stringify(targetFilter || 'all')})`);

        // Batch size 50 with BCC protects student privacy & complies with SMTP rate limits
        const BATCH_SIZE = 50;
        const batches = [];
        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            batches.push(emails.slice(i, i + BATCH_SIZE));
        }

        console.log(`📦 Sending ${batches.length} batch(es)`);

        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
                console.log(`📤 Sending batch ${i + 1}/${batches.length} (${batch.length} recipients)`);

                const result = await sendEmail({
                    bcc: batch,
                    subject,
                    html,
                    text
                });

                if (result.success) {
                    successCount += batch.length;
                } else {
                    console.error(`❌ Batch ${i + 1} failed:`, result.error);
                    errorCount += batch.length;
                }

                // 5-second interval between batches to respect rate limits
                if (i < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }

            } catch (error) {
                console.error(`❌ Batch ${i + 1} threw an error:`, error);
                errorCount += batch.length;
            }
        }

        // Log notification to database
        await logNotification({
            type: 'bulk_email',
            subject,
            recipient_count: students.length,
            target_filter: targetFilter || 'all',
            success_count: successCount,
            error_count: errorCount
        });

        console.log(`✅ Email campaign complete: ${successCount} sent, ${errorCount} failed`);

        return {
            success: true,
            sent: successCount,
            failed: errorCount,
            total: students.length,
            targetFilter: targetFilter || 'all'
        };

    } catch (error) {
        console.error('❌ Bulk email error:', error);
        throw error;
    }
}

// ============================================
// LOG NOTIFICATION
// ============================================

async function logNotification(data) {
    try {
        const { error } = await supabase
            .from('notifications')
            .insert({
                ...data,
                created_at: new Date().toISOString()
            });

        if (error) {
            console.error('❌ Log notification error:', error);
        }
    } catch (error) {
        console.error('❌ Log notification error:', error);
    }
}

// ============================================
// EMAIL TEMPLATE BUILDER & TEMPLATES
// ============================================

function formatNaira(amount) {
    if (amount === null || amount === undefined || amount === '') return '₦0';
    const num = Number(String(amount).replace(/[^0-9.-]+/g, ''));
    if (isNaN(num)) return `₦${amount}`;
    return '₦' + num.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPrizePool(prize) {
    if (!prize) return 'Prizes & Recognition';
    const str = String(prize).trim();
    if (/^\d+(\.\d+)?$/.test(str)) {
        return '₦' + Number(str).toLocaleString('en-NG');
    }
    return str;
}

function renderBaseLayout({
    headerBadge,
    headerTitle,
    headerSubtitle,
    contentTitle,
    metaRows = [],
    extraHtml = '',
    buttonText,
    buttonUrl,
    noticeText
}) {
    const rowsHtml = metaRows.map(row => `
        <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #4a5568; width: 35%; border-bottom: 1px solid #edf2f7; font-size: 13px;">${row.label}</td>
            <td style="padding: 10px 14px; color: #1a202c; border-bottom: 1px solid #edf2f7; font-size: 14px;">${row.value}</td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${headerTitle}</title>
    <style>
        body { margin: 0; padding: 0; background-color: #f4f7f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #2d3748; line-height: 1.6; }
        .wrapper { width: 100%; background-color: #f4f7f6; padding: 30px 15px; box-sizing: border-box; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
        .header { background: linear-gradient(135deg, #1b8c0c 0%, #136308 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
        .badge-pill { display: inline-block; background: rgba(255,255,255,0.22); padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #ffffff; margin-bottom: 10px; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; }
        .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.92; color: #e8f5e9; }
        .body-content { padding: 32px 28px; }
        .title { color: #0f172a; font-size: 19px; font-weight: 700; margin: 0 0 16px; }
        .info-table { width: 100%; border-collapse: collapse; margin: 18px 0; background: #f8fafc; border-radius: 8px; overflow: hidden; }
        .badge { display: inline-block; padding: 3px 9px; border-radius: 6px; font-size: 12px; font-weight: 600; background: #e8f5e9; color: #1b8c0c; }
        .badge-prize { background: #fef3c7; color: #b45309; font-weight: 700; font-size: 12px; }
        .badge-alert { background: #fee2e2; color: #b91c1c; font-weight: 600; font-size: 12px; }
        .desc-box { background: #f8fafc; border-left: 4px solid #1b8c0c; padding: 12px 16px; margin: 18px 0; font-size: 14px; color: #4a5568; border-radius: 0 6px 6px 0; line-height: 1.5; }
        .btn-wrapper { text-align: center; margin: 28px 0 16px; }
        .btn { display: inline-block; background-color: #1b8c0c; color: #ffffff !important; padding: 13px 30px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 12px rgba(27,140,12,0.3); }
        .footer { text-align: center; color: #718096; font-size: 12px; padding: 22px 20px 0; border-top: 1px solid #edf2f7; margin-top: 24px; }
        .footer p { margin: 4px 0; }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="card">
            <div class="header">
                ${headerBadge ? `<span class="badge-pill">${headerBadge}</span>` : ''}
                <h1>${headerTitle}</h1>
                ${headerSubtitle ? `<p>${headerSubtitle}</p>` : ''}
            </div>
            <div class="body-content">
                ${contentTitle ? `<h2 class="title">${contentTitle}</h2>` : ''}
                ${metaRows.length > 0 ? `<table class="info-table">${rowsHtml}</table>` : ''}
                ${extraHtml}
                <div class="btn-wrapper">
                    <a href="${buttonUrl}" class="btn" target="_blank">${buttonText}</a>
                </div>
                ${noticeText ? `<p style="color: #64748b; font-size: 13px; text-align: center; margin-top: 20px;">${noticeText}</p>` : ''}
                <div class="footer">
                    <p style="font-weight: 600; color: #475569;">Nigerian Association of Computing Students (NACOS)</p>
                    <p>Thomas Adewumi University Chapter • Oko-Irese, Kwara State</p>
                    <p style="color: #94a3b8; font-size: 11px; margin-top: 8px;">You received this notification because you are an active student member of NACOS TAU.</p>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
    `;
}

function getEmailTemplate(type, data = {}) {
    const templates = {
        // 1. Past Question
        new_past_question: (item) => {
            const courseCode = item.course_code || 'Past Question';
            const courseName = item.course_name ? ` — ${item.course_name}` : '';
            const titleHtml = item.title ? `<p style="margin: 6px 0 0; color: #475569; font-size: 14px;"><strong>Title:</strong> ${item.title}</p>` : '';
            const level = item.level ? `${item.level} Level` : 'All Levels';
            const semester = item.semester || 'Semester Examination';
            const session = item.academic_session || item.year || '';
            const actionUrl = `${FRONTEND_URL}/past-questions.html`;

            const metaRows = [
                { label: 'Course Code', value: `<span class="badge">${courseCode}</span>` },
                ...(item.course_name ? [{ label: 'Course Title', value: item.course_name }] : []),
                { label: 'Level', value: `<span class="badge">${level}</span>` },
                { label: 'Semester', value: semester },
                ...(session ? [{ label: 'Session / Year', value: session }] : []),
            ];

            return renderBaseLayout({
                headerBadge: 'Past Exam Question',
                headerTitle: '📚 New Past Question Available',
                headerSubtitle: 'Study smart with official past exam materials',
                contentTitle: `${courseCode}${courseName}`,
                metaRows,
                extraHtml: titleHtml,
                buttonText: 'View & Download Past Question',
                buttonUrl: actionUrl,
                noticeText: 'Access all Computing and Software Engineering past questions directly on the NACOS portal.'
            });
        },

        // 2. Timetable
        new_timetable: (item) => {
            const title = item.title || 'Academic Schedule';
            const dept = item.department || 'Computing Sciences';
            const level = item.level ? `${item.level} Level` : 'All Levels';
            const semester = item.semester || 'Current Semester';
            const session = item.academic_session || '2026/2027';
            const actionUrl = `${FRONTEND_URL}/timetables.html`;
            const desc = item.description ? `<div class="desc-box">${item.description}</div>` : '';

            const metaRows = [
                { label: 'Department', value: dept },
                { label: 'Level', value: `<span class="badge">${level}</span>` },
                { label: 'Semester', value: semester },
                { label: 'Academic Session', value: session },
                ...(item.version ? [{ label: 'Version', value: `v${item.version}` }] : [])
            ];

            return renderBaseLayout({
                headerBadge: 'Academic Timetable',
                headerTitle: '📅 New Timetable Released',
                headerSubtitle: 'Check your schedule and never miss a lecture or exam',
                contentTitle: title,
                metaRows,
                extraHtml: desc,
                buttonText: 'View Timetable Schedule',
                buttonUrl: actionUrl,
                noticeText: 'Timetables are updated in real-time. Check the portal for any lecture hall changes.'
            });
        },

        // 3. Academic Resource
        new_resource: (item) => {
            const title = item.title || 'Academic Resource';
            const type = {
                'reference_material': 'Documentation',
                'tutorial': 'Tutorial',
                'lecture_note': 'Course',
                'past_question': 'Past Question'
            }[item.resource_type] || item.resource_type || 'Study Material';
            const course = item.course || 'All Courses';
            const actionUrl = `${FRONTEND_URL}/resources.html`;
            const desc = item.description ? `<div class="desc-box">${item.description}</div>` : '';

            const metaRows = [
                { label: 'Resource Type', value: `<span class="badge">${type}</span>` },
                { label: 'Course', value: course },
                ...(item.semester ? [{ label: 'Semester', value: item.semester }] : []),
                ...(item.author ? [{ label: 'Uploaded By / Author', value: item.author }] : [])
            ];

            return renderBaseLayout({
                headerBadge: 'Academic Resource',
                headerTitle: '📖 New Study Resource Available',
                headerSubtitle: 'Fresh lecture notes, syllabi, and reference materials are ready',
                contentTitle: title,
                metaRows,
                extraHtml: desc,
                buttonText: 'Access Academic Resources',
                buttonUrl: actionUrl,
                noticeText: 'Download course outlines, slides, and reference materials directly from the portal.'
            });
        },

        // 4. Career Path
        new_career_path: (item) => {
            const title = item.title || 'Career Path';
            const category = item.category || 'Technology';
            const actionUrl = `${FRONTEND_URL}/career-paths.html`;
            const desc = item.description ? `<div class="desc-box">${item.description}</div>` : '';

            const skills = Array.isArray(item.skills) && item.skills.length
                ? item.skills.map(s => `<span class="badge" style="margin: 2px 4px 2px 0;">${s}</span>`).join(' ')
                : '';
            const tools = Array.isArray(item.tools) && item.tools.length
                ? item.tools.map(t => `<span class="badge" style="background:#e0f2fe; color:#0369a1; margin: 2px 4px 2px 0;">${t}</span>`).join(' ')
                : '';

            const metaRows = [
                { label: 'Domain / Category', value: `<span class="badge">${category}</span>` },
                ...(skills ? [{ label: 'Key Skills', value: skills }] : []),
                ...(tools ? [{ label: 'Essential Tools', value: tools }] : []),
                ...(item.salary_range ? [{ label: 'Salary Outlook', value: item.salary_range }] : [])
            ];

            return renderBaseLayout({
                headerBadge: 'Career Roadmap',
                headerTitle: '🚀 New Career Guide Added',
                headerSubtitle: 'Equip yourself for industry leadership and career growth',
                contentTitle: title,
                metaRows,
                extraHtml: desc,
                buttonText: 'Explore Career Roadmap',
                buttonUrl: actionUrl,
                noticeText: 'Learn the required skills, milestones, and recommended courses to break into this field.'
            });
        },

        // 5. Event
        new_event: (item) => {
            const title = item.title || 'NACOS Event';
            const eventType = item.event_type || 'Departmental Event';
            const dateStr = item.date ? new Date(item.date).toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBA';
            const timeStr = item.time || 'TBA';
            const location = item.location || 'TAU Campus';
            const actionUrl = `${FRONTEND_URL}/events.html`;
            const desc = item.description ? `<div class="desc-box">${item.description}</div>` : '';

            const metaRows = [
                { label: 'Event Type', value: `<span class="badge">${eventType}</span>` },
                { label: 'Date', value: dateStr },
                { label: 'Time', value: timeStr },
                { label: 'Location / Venue', value: location },
                ...(item.requires_payment ? [{ label: 'Event Fee', value: item.payment_amount ? formatNaira(item.payment_amount) : 'Free' }] : [])
            ];

            return renderBaseLayout({
                headerBadge: 'Upcoming Event',
                headerTitle: '🎉 New Event Announced',
                headerSubtitle: 'Join fellow computing students and expand your horizons',
                contentTitle: title,
                metaRows,
                extraHtml: desc,
                buttonText: 'View Event Details',
                buttonUrl: actionUrl,
                noticeText: 'Mark your calendar and ensure your attendance for this event.'
            });
        },

        // 6. Hackathon / Pitchathon
        new_hackathon: (item) => {
            const title = item.title || 'Tech Challenge';
            const eventType = (item.event_type || 'Hackathon').toUpperCase();
            const mode = item.mode ? `${item.mode.charAt(0).toUpperCase() + item.mode.slice(1)}` : 'Hybrid';
            const prize = item.prize_pool ? `<span class="badge badge-prize">${formatPrizePool(item.prize_pool)}</span>` : 'Prizes & Recognition';
            const actionUrl = `${FRONTEND_URL}/hackathons.html`;
            const desc = item.description ? `<div class="desc-box">${item.description}</div>` : '';
            const tagline = item.tagline ? `<p style="margin: 0 0 12px; font-weight: 600; color: #1b8c0c; font-size: 15px;">${item.tagline}</p>` : '';

            const deadlineStr = item.registration_deadline
                ? new Date(item.registration_deadline).toLocaleDateString('en-NG', { month: 'short', day: 'numeric', year: 'numeric' })
                : null;
            const dateRangeStr = item.start_date && item.end_date
                ? `${new Date(item.start_date).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })} – ${new Date(item.end_date).toLocaleDateString('en-NG', { month: 'short', day: 'numeric', year: 'numeric' })}`
                : null;

            const metaRows = [
                { label: 'Format', value: `<span class="badge">${mode}</span>` },
                { label: 'Prize Pool', value: prize },
                ...(dateRangeStr ? [{ label: 'Event Dates', value: dateRangeStr }] : []),
                ...(deadlineStr ? [{ label: 'Registration Deadline', value: `<span class="badge badge-alert">${deadlineStr}</span>` }] : []),
                ...(item.location ? [{ label: 'Venue / Platform', value: item.location }] : [])
            ];

            return renderBaseLayout({
                headerBadge: 'Tech Competition',
                headerTitle: `🏆 New ${eventType} Announced!`,
                headerSubtitle: 'Showcase your skills, build real projects, and win prizes',
                contentTitle: title,
                metaRows,
                extraHtml: tagline + desc,
                buttonText: 'Register Your Team Now',
                buttonUrl: actionUrl,
                noticeText: 'Form or join a team, pitch your solution, and compete for top prizes on the NACOS TAU platform.'
            });
        },

        // 7. General Announcement
        announcement: (item) => {
            const title = item.title || 'NACOS Announcement';
            const message = item.message ? `<div class="desc-box">${item.message}</div>` : '';
            const actionUrl = item.link || `${FRONTEND_URL}/index.html`;

            return renderBaseLayout({
                headerBadge: 'Announcement',
                headerTitle: '📢 Official NACOS Announcement',
                headerSubtitle: 'Important update from the Executive Council',
                contentTitle: title,
                metaRows: [],
                extraHtml: message,
                buttonText: 'Learn More on Portal',
                buttonUrl: actionUrl,
                noticeText: 'Stay informed with all official announcements and updates.'
            });
        }
    };

    return templates[type] ? templates[type](data) : (data.html || '');
}

// ============================================
// AUTOMATIC BROADCAST DISPATCHER
// ============================================

/**
 * Automatically triggers a background bulk broadcast email to all active students
 * when new content is published.
 *
 * Safe and non-blocking: Runs in Node's setImmediate, so HTTP callers return instantly.
 *
 * @param {string} contentType - One of: 'past_questions', 'timetables', 'academic_resources', 'career_paths', 'events', 'hackathons'
 * @param {object} itemData - The newly created database record
 */
function triggerAutoContentBroadcast(contentType, itemData, options = {}) {
    if (!itemData || typeof itemData !== 'object') return;

    // Do not notify for unpublished or explicitly inactive items
    if (itemData.is_published === false || itemData.is_active === false) {
        console.log(`[AutoBroadcast] Skipped broadcast for inactive/unpublished item in ${contentType}`);
        return;
    }

    let templateType = '';
    let subject = '';
    let targetFilter = options.targetFilter || itemData.target_filter || null;

    switch (contentType) {
        case 'past_questions':
            templateType = 'new_past_question';
            subject = `📚 New Past Question: ${itemData.course_code || 'Course'} ${itemData.course_name ? '— ' + itemData.course_name : (itemData.title || '')}`.trim();
            // Automatically infer target audience from level and course code if not specified
            if (!targetFilter && itemData.level) {
                let inferredDept = itemData.department || null;
                const code = String(itemData.course_code || '').toUpperCase();
                if (!inferredDept) {
                    if (code.startsWith('SEN') || code.startsWith('SWE')) inferredDept = 'Software Engineering';
                    else if (code.startsWith('CSC') || code.startsWith('CMP')) inferredDept = 'Computer Science';
                }
                targetFilter = {
                    audiences: [{
                        level: itemData.level,
                        department: inferredDept
                    }]
                };
            }
            break;
        case 'timetables':
            templateType = 'new_timetable';
            subject = `📅 New Timetable: ${itemData.title || 'Academic Schedule Released'}`;
            // Automatically infer target audience from level & department if present
            if (!targetFilter && (itemData.level || itemData.department)) {
                targetFilter = {
                    audiences: [{
                        level: itemData.level || null,
                        department: itemData.department || null
                    }]
                };
            }
            break;
        case 'academic_resources':
            templateType = 'new_resource';
            subject = `📖 New Academic Resource: ${itemData.title || 'Study Material Available'}`;
            if (!targetFilter && (itemData.level || itemData.department)) {
                targetFilter = {
                    audiences: [{
                        level: itemData.level || null,
                        department: itemData.department || null
                    }]
                };
            }
            break;
        case 'career_paths':
            templateType = 'new_career_path';
            subject = `🚀 New Career Roadmap: ${itemData.title || 'Tech Career Guide'}`;
            break;
        case 'events':
            templateType = 'new_event';
            subject = `🎉 New Event: ${itemData.title || 'Upcoming NACOS Event'}`;
            break;
        case 'hackathons':
            templateType = 'new_hackathon';
            const typeUpper = (itemData.event_type || 'Competition').toUpperCase();
            const prizeSnippet = itemData.prize_pool ? ` (${itemData.prize_pool})` : '';
            subject = `🏆 New ${typeUpper}: ${itemData.title || 'Challenge Announced'}${prizeSnippet}`;
            break;
        default:
            return;
    }

    // Run completely in background (fire-and-forget, non-blocking)
    setImmediate(async () => {
        try {
            console.log(`🚀 [AutoBroadcast] Preparing broadcast for ${contentType}: "${subject}" (Target: ${JSON.stringify(targetFilter || 'all')})`);
            const html = getEmailTemplate(templateType, itemData);
            const textSummary = itemData.description || itemData.tagline || itemData.title || subject;

            let res = await sendBulkEmail({
                subject,
                html,
                text: textSummary,
                targetFilter
            });

            // If targeted combo returned 0 matches, fallback gracefully to all active students
            if (res && res.count === 0 && targetFilter) {
                console.log(`[AutoBroadcast] No students matched inferred target. Retrying broadcast to all active students...`);
                res = await sendBulkEmail({
                    subject,
                    html,
                    text: textSummary,
                    targetFilter: null
                });
            }

            console.log(`✅ [AutoBroadcast] Broadcast finished for ${contentType}:`, res);
        } catch (err) {
            console.error(`❌ [AutoBroadcast] Broadcast failed for ${contentType}:`, err?.message || err);
        }
    });
}

// ============================================
// SEND EVENT TICKET CONFIRMATION EMAIL
// ============================================
async function sendEventTicketEmail({ student, event, ticketNumber, payment }) {
    if (!student || !student.email || !event) return;
    try {
        const studentName = student.name || `${student.first_name || ''} ${student.last_name || ''}`.trim() || 'Student';
        const eventTitle = event.title || 'NACOS Event';
        const dateStr = event.date ? new Date(event.date).toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBA';
        const timeStr = event.time || 'TBA';
        const locationStr = event.location || 'TAU Campus';
        const amountStr = payment?.amount ? formatNaira(payment.amount) : (event.payment_amount ? formatNaira(event.payment_amount) : 'Free');
        const refStr = payment?.transaction_id || payment?.reference || 'N/A';
        const ticketUrl = `${FRONTEND_URL}/events.html`;

        const metaRows = [
            { label: 'Ticket Number', value: `<strong style="font-size: 16px; color: #1b8c0c; letter-spacing: 1px;">${ticketNumber}</strong>` },
            { label: 'Event', value: `<strong>${eventTitle}</strong>` },
            { label: 'Attendee', value: studentName },
            ...(student.matric_no ? [{ label: 'Matric No', value: student.matric_no }] : []),
            { label: 'Date', value: dateStr },
            { label: 'Time', value: timeStr },
            { label: 'Location / Venue', value: locationStr },
            { label: 'Fee Paid', value: `<span class="badge" style="background:#e8f5e9; color:#1b8c0c; font-weight:700;">${amountStr}</span>` },
            { label: 'Payment Reference', value: `<code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size:12px;">${refStr}</code>` }
        ];

        const ticketNotice = `
            <div style="background: #f0fdf4; border: 1px dashed #22c55e; border-radius: 8px; padding: 14px; margin: 18px 0; text-align: center;">
                <p style="margin: 0; font-size: 13px; color: #166534;">
                    🎟️ <strong>Admission Notice:</strong> Present this email or your ticket number <strong>${ticketNumber}</strong> at the event entrance for verification.
                </p>
            </div>
        `;

        const html = renderBaseLayout({
            headerBadge: 'Payment Verified & Confirmed',
            headerTitle: '🎟️ Event Registration Ticket',
            headerSubtitle: `Your seat is secured for ${eventTitle}`,
            contentTitle: `Hi ${studentName}, you're all set!`,
            metaRows,
            extraHtml: ticketNotice,
            buttonText: 'View Events Portal',
            buttonUrl: ticketUrl,
            noticeText: 'Please keep this email for your records.'
        });

        return await sendEmail({
            to: student.email,
            subject: `🎟️ Ticket Confirmed: ${eventTitle} — NACOS TAU`,
            html,
            text: `Hi ${studentName},\n\nYour registration and payment for "${eventTitle}" have been verified!\nTicket Number: ${ticketNumber}\nDate: ${dateStr}\nTime: ${timeStr}\nVenue: ${locationStr}\nFee Paid: ${amountStr}\nPayment Ref: ${refStr}\n\nShow this ticket number at the venue entrance.\n\nNACOS TAU Chapter`
        });
    } catch (err) {
        console.error('Failed to send event ticket confirmation email:', err);
    }
}

// ============================================
// SEND PAYMENT ALERT TO ADMIN (nacos@tau.edu.ng)
// ============================================
async function sendPaymentAdminNotificationEmail({ student, event, payment, ticketNumber }) {
    try {
        const adminEmail = process.env.ADMIN_EMAIL || 'nacos@tau.edu.ng';
        const studentName = student?.name || `${student?.first_name || ''} ${student?.last_name || ''}`.trim() || 'Student';
        const amountStr = payment?.amount ? formatNaira(payment.amount) : (event?.payment_amount ? formatNaira(event.payment_amount) : '₦0');
        const refStr = payment?.transaction_id || payment?.reference || 'N/A';
        const eventTitle = event?.title || payment?.description || 'Event / Dues';
        const dateStr = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
        const adminUrl = `${FRONTEND_URL}/admin-dashboard.html`;

        const metaRows = [
            { label: 'Amount Received', value: `<strong style="font-size: 16px; color: #1b8c0c;">${amountStr}</strong>` },
            { label: 'Paid For', value: `<strong>${eventTitle}</strong>` },
            { label: 'Student / Payer', value: studentName },
            ...(student?.matric_no ? [{ label: 'Matric No', value: student.matric_no }] : []),
            ...(student?.email ? [{ label: 'Student Email', value: student.email }] : []),
            ...(student?.department ? [{ label: 'Department', value: student.department }] : []),
            ...(ticketNumber ? [{ label: 'Ticket Issued', value: `<code>${ticketNumber}</code>` }] : []),
            { label: 'Paystack Ref', value: `<code>${refStr}</code>` },
            { label: 'Payment Time', value: dateStr },
            { label: 'Gateway Status', value: `<span class="badge" style="background:#e8f5e9; color:#1b8c0c; font-weight:700;">Verified (Paystack)</span>` }
        ];

        const html = renderBaseLayout({
            headerBadge: 'Payment Notification',
            headerTitle: '💰 New Payment Received',
            headerSubtitle: `Online payment received from ${studentName}`,
            contentTitle: `${amountStr} Received via Paystack`,
            metaRows,
            extraHtml: `
                <div style="background: #f8fafc; border-left: 4px solid #1b8c0c; padding: 12px 16px; margin: 18px 0; font-size: 14px; color: #334155;">
                    This payment was automatically verified by the Paystack payment gateway and recorded in the database.
                </div>
            `,
            buttonText: 'Open Admin Dashboard',
            buttonUrl: adminUrl,
            noticeText: 'NACOS TAU Financial & Administrative Notification'
        });

        // Always notify nacos@tau.edu.ng, olufemi-abiodun.gbolahan@st.tau.edu.ng, and custom ADMIN_EMAIL
        const recipients = ['nacos@tau.edu.ng', 'olufemi-abiodun.gbolahan@st.tau.edu.ng'];
        if (adminEmail && adminEmail !== 'nacos@tau.edu.ng' && adminEmail !== 'olufemi-abiodun.gbolahan@st.tau.edu.ng') {
            recipients.push(adminEmail);
        }

        return await sendEmail({
            to: recipients,
            subject: `💰 Payment Received: ${amountStr} from ${studentName} (${eventTitle})`,
            html,
            text: `New Payment Received!\nAmount: ${amountStr}\nStudent: ${studentName} (${student?.matric_no || 'N/A'})\nEvent: ${eventTitle}\nRef: ${refStr}\nTicket: ${ticketNumber || 'N/A'}\nTime: ${dateStr}\n\nNACOS TAU Portal`
        });
    } catch (err) {
        console.error('Failed to send admin payment notification email:', err);
    }
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    sendEmail,
    sendBulkEmail,
    sendEventTicketEmail,
    sendPaymentAdminNotificationEmail,
    getActiveStudents,
    getEmailTemplate,
    logNotification,
    triggerAutoContentBroadcast,
    normalizeLevel,
    normalizeDepartment,
    matchesTargetFilter
};