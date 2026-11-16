// routes/siteContent.js
// Public & Admin API for Homepage CMS (site_settings + current executives)
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

function isMissingTableError(error) {
    if (!error) return false;
    const msg = String(error.message || '').toLowerCase();
    return error.code === '42P01' || error.code === 'PGRST205' || msg.includes('does not exist') || msg.includes('schema cache');
}

// ============================================
// 1. PUBLIC: GET HOMEPAGE CONTENT (SETTINGS + ACTIVE EXECUTIVES)
// ============================================
router.get('/', async (req, res) => {
    try {
        const [settingsRes, execsRes] = await Promise.all([
            supabase
                .from('site_settings')
                .select('*')
                .eq('id', 1)
                .maybeSingle(),
            supabase
                .from('executives')
                .select('*')
                .eq('is_active', true)
                .order('rank_order', { ascending: true })
                .order('full_name', { ascending: true })
        ]);

        let settings = settingsRes.data || null;
        if (settingsRes.error && !isMissingTableError(settingsRes.error)) {
            throw settingsRes.error;
        }

        let executives = execsRes.data || [];
        if (execsRes.error && !isMissingTableError(execsRes.error)) {
            throw execsRes.error;
        }

        return successResponse(res, { settings, executives }, 'Site content retrieved successfully');
    } catch (error) {
        console.error('Site content fetch error:', error);
        return errorResponse(res, 'Failed to fetch site content', 500, error);
    }
});

// ============================================
// 2. ADMIN: GET ALL EXECUTIVES (INCLUDING INACTIVE)
// ============================================
router.get('/executives/all', authenticate, requireAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('executives')
            .select('*')
            .order('rank_order', { ascending: true })
            .order('full_name', { ascending: true });

        if (error) {
            if (isMissingTableError(error)) {
                return successResponse(res, { executives: [], tableMissing: true }, 'Executives table not yet migrated');
            }
            throw error;
        }

        return successResponse(res, { executives: data || [] }, 'All executives retrieved successfully');
    } catch (error) {
        console.error('Admin fetch all executives error:', error);
        return errorResponse(res, 'Failed to fetch executives', 500, error);
    }
});

// ============================================
// 3. ADMIN: UPDATE SITE SETTINGS (ROW id = 1)
// ============================================
const ALLOWED_SETTINGS_FIELDS = [
    'hero_title_prefix',
    'hero_title_highlight',
    'hero_subtitle',
    'about_heading',
    'about_intro',
    'about_bullets',
    'exec_session',
    'exec_subtitle',
    'bank_account_number',
    'bank_account_name',
    'bank_name',
    'dues_amount',
    'payment_note',
    'payment_reference_format',
    'contact_email',
    'inquiry_contacts'
];

router.put('/settings', authenticate, requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const patch = { id: 1, updated_at: new Date().toISOString(), updated_by: req.userId || null };

        for (const key of ALLOWED_SETTINGS_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
                patch[key] = body[key];
            }
        }

        // Validate array fields if provided
        if (patch.about_bullets !== undefined && !Array.isArray(patch.about_bullets)) {
            return errorResponse(res, 'about_bullets must be an array of strings', 400);
        }
        if (patch.inquiry_contacts !== undefined && !Array.isArray(patch.inquiry_contacts)) {
            return errorResponse(res, 'inquiry_contacts must be an array of { label, url } objects', 400);
        }

        const { data, error } = await supabase
            .from('site_settings')
            .upsert(patch, { onConflict: 'id' })
            .select()
            .single();

        if (error) throw error;

        await auditLog({
            action: 'site_settings_updated',
            userId: req.userId,
            details: { updated_fields: Object.keys(patch).filter(k => !['id', 'updated_at', 'updated_by'].includes(k)) },
            ip: req.ip
        });

        return successResponse(res, { settings: data }, 'Site settings updated successfully');
    } catch (error) {
        console.error('Update site settings error:', error);
        return errorResponse(res, 'Failed to update site settings', 500, error);
    }
});

module.exports = router;
