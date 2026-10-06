const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { errorResponse, successResponse } = require('../utils/helpers');
const { sendBulkEmail, getEmailTemplate } = require('../services/email');
const { rateLimit } = require('express-rate-limit');

// Rate limiter specifically for broadcasting to prevent abuse
const broadcastLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 5, // Limit each IP to 5 broadcast requests per windowMs
    message: { error: 'Too many broadcasts sent from this IP, please try again after an hour' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * @route   POST /api/emails/broadcast
 * @desc    Send a bulk email to all active students
 * @access  Private/Admin
 */
router.post('/broadcast', authenticate, requireAdmin, broadcastLimiter, async (req, res) => {
    try {
        const { type, subject, message, link, title } = req.body;

        if (!type || !subject) {
            return errorResponse(res, 'Missing required fields: type and subject are required.', 400);
        }

        // Validate template type
        const validTypes = ['new_resource', 'new_event', 'announcement'];
        if (!validTypes.includes(type)) {
            return errorResponse(res, 'Invalid email template type.', 400);
        }

        // Prepare template data based on type
        let templateData = {};
        if (type === 'announcement') {
            templateData = { title: title || subject, message, link };
        } else if (type === 'new_resource') {
            templateData = { title: title || subject, description: message, course: req.body.course, resource_type: req.body.resource_type };
        } else if (type === 'new_event') {
            templateData = { title: title || subject, description: message, date: req.body.date, time: req.body.time, location: req.body.location };
        }

        // Generate HTML from template
        const html = getEmailTemplate(type, templateData);
        
        // Start bulk email job
        // (This runs asynchronously, we return a success response immediately so the admin isn't blocked)
        sendBulkEmail({ subject, html, text: message })
            .then(result => {
                console.log('✅ Bulk email broadcast completed:', result);
                
                // Audit the action
                auditLog({
                    action: 'email_broadcast',
                    userId: req.user.id,
                    details: { subject, type, stats: result }
                });
            })
            .catch(err => {
                console.error('❌ Bulk email broadcast failed:', err);
                
                auditLog({
                    action: 'email_broadcast_failed',
                    userId: req.user.id,
                    details: { subject, type, error: err.message }
                });
            });

        return successResponse(res, 'Broadcast initiated successfully. Emails are being sent in the background.', { subject, type });
        
    } catch (error) {
        console.error('Error initiating broadcast:', error);
        return errorResponse(res, 'Failed to initiate broadcast', 500, error);
    }
});

module.exports = router;
