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
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://nacosportal.vercel.app';

let transporter = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT == 465, // true for 465, false for other ports (587)
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
        },
    });
    console.log('✅ SMTP email provider initialized');
} else {
    console.log('⚠️ SMTP credentials not fully set, email sending disabled');
}

// ============================================
// SEND SINGLE EMAIL
// ============================================

async function sendEmail({ to, subject, html, text }) {
    try {
        if (!transporter) {
            console.log('⚠️ Email not sent - SMTP not initialized');
            console.log(`📧 Would send to: ${to}`);
            console.log(`📧 Subject: ${subject}`);
            return { success: false, error: 'SMTP not initialized' };
        }

        const mailOptions = {
            from: EMAIL_FROM,
            to: Array.isArray(to) ? to.join(', ') : to,
            subject: subject,
            html: html,
            text: text || html.replace(/<[^>]*>/g, ''),
        };

        const info = await transporter.sendMail(mailOptions);

        console.log(`✅ Email sent to ${Array.isArray(to) ? to.length : 1} recipient(s) [ID: ${info.messageId}]`);
        return { success: true, data: info };
        
    } catch (error) {
        console.error('❌ Email send error:', error);
        throw error;
    }
}

// ============================================
// GET ALL ACTIVE STUDENTS
// ============================================

async function getActiveStudents() {
    try {
        const { data, error } = await supabase
            .from('students')
            .select('email, name, matric_no, user_id')
            .eq('status', 'active');

        if (error) throw error;
        console.log(`📊 Found ${data.length} active students`);
        return data;
    } catch (error) {
        console.error('❌ Get students error:', error);
        return [];
    }
}

// ============================================
// SEND BULK EMAIL TO ALL STUDENTS
// ============================================

async function sendBulkEmail({ subject, html, text }) {
    try {
        const students = await getActiveStudents();
        
        if (students.length === 0) {
            console.log('⚠️ No active students found');
            return { success: true, message: 'No students to notify' };
        }

        // Get all emails
        const emails = students.map(s => s.email);
        
        console.log(`📧 Sending to ${emails.length} students`);

        // Resend free tier limit: 100 emails per send
        // We'll send in batches of 50
        const BATCH_SIZE = 50;
        const batches = [];
        
        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            batches.push(emails.slice(i, i + BATCH_SIZE));
        }

        console.log(`📦 Sending ${batches.length} batches`);

        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
                console.log(`📤 Sending batch ${i + 1}/${batches.length} (${batch.length} recipients)`);
                
                const result = await sendEmail({
                    to: batch,
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
                
                // Wait 1 second between batches (rate limiting)
                if (i < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
            } catch (error) {
                console.error(`❌ Batch ${i + 1} threw an error:`, error);
                errorCount += batch.length;
            }
        }

        // Log notification
        await logNotification({
            type: 'bulk_email',
            subject,
            recipient_count: students.length,
            success_count: successCount,
            error_count: errorCount
        });

        console.log(`✅ Email campaign complete: ${successCount} sent, ${errorCount} failed`);

        return {
            success: true,
            sent: successCount,
            failed: errorCount,
            total: students.length
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
// EMAIL TEMPLATES
// ============================================

function getEmailTemplate(type, data) {
    const templates = {
        new_resource: (resource) => `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Resource Available</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f8fbfc; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #1b8c0c; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                    .header h1 { color: white; margin: 0; font-size: 24px; }
                    .content { background: white; padding: 30px; border-radius: 0 0 10px 10px; }
                    .btn { display: inline-block; background: #1b8c0c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                    .footer { text-align: center; color: #999; font-size: 12px; padding: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>📚 New Resource Available</h1>
                    </div>
                    <div class="content">
                        <h2 style="color: #1b8c0c;">${resource.title}</h2>
                        <p><strong>Type:</strong> ${resource.resource_type || 'General'}</p>
                        <p><strong>Course:</strong> ${resource.course || 'All'}</p>
                        ${resource.description ? `<p>${resource.description}</p>` : ''}
                        <div style="text-align: center;">
                            <a href="${FRONTEND_URL}/resources" class="btn">View Resources</a>
                        </div>
                        <p style="color: #666; font-size: 12px;">You received this email because you are a registered NACOS member.</p>
                    </div>
                    <div class="footer">
                        <p>NACOS - Thomas Adewumi University</p>
                    </div>
                </div>
            </body>
            </html>
        `,

        new_event: (event) => `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Event</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f8fbfc; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #1b8c0c; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                    .header h1 { color: white; margin: 0; font-size: 24px; }
                    .content { background: white; padding: 30px; border-radius: 0 0 10px 10px; }
                    .btn { display: inline-block; background: #1b8c0c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                    .footer { text-align: center; color: #999; font-size: 12px; padding: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🎉 New Event!</h1>
                    </div>
                    <div class="content">
                        <h2 style="color: #1b8c0c;">${event.title}</h2>
                        <p><strong>📅 Date:</strong> ${new Date(event.date).toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        ${event.time ? `<p><strong>⏰ Time:</strong> ${event.time}</p>` : ''}
                        ${event.location ? `<p><strong>📍 Location:</strong> ${event.location}</p>` : ''}
                        ${event.description ? `<p>${event.description}</p>` : ''}
                        <div style="text-align: center;">
                            <a href="${FRONTEND_URL}/events" class="btn">View Events</a>
                        </div>
                        <p style="color: #666; font-size: 12px;">You received this email because you are a registered NACOS member.</p>
                    </div>
                    <div class="footer">
                        <p>NACOS - Thomas Adewumi University</p>
                    </div>
                </div>
            </body>
            </html>
        `,

        announcement: (announcement) => `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>NACOS Announcement</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f8fbfc; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #1b8c0c; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                    .header h1 { color: white; margin: 0; font-size: 24px; }
                    .content { background: white; padding: 30px; border-radius: 0 0 10px 10px; }
                    .btn { display: inline-block; background: #1b8c0c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                    .footer { text-align: center; color: #999; font-size: 12px; padding: 20px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>📢 NACOS Announcement</h1>
                    </div>
                    <div class="content">
                        <h2 style="color: #1b8c0c;">${announcement.title}</h2>
                        <p>${announcement.message}</p>
                        ${announcement.link ? `
                            <div style="text-align: center;">
                                <a href="${announcement.link}" class="btn">Learn More</a>
                            </div>
                        ` : ''}
                        <p style="color: #666; font-size: 12px;">You received this email because you are a registered NACOS member.</p>
                    </div>
                    <div class="footer">
                        <p>NACOS - Thomas Adewumi University</p>
                    </div>
                </div>
            </body>
            </html>
        `
    };

    return templates[type] ? templates[type](data) : data.html || '';
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    sendEmail,
    sendBulkEmail,
    getActiveStudents,
    getEmailTemplate,
    logNotification
};