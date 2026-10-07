// routes/pastExecutives.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// 1. PUBLIC: GET ALL PAST EXECUTIVES
// ============================================
router.get('/', async (req, res) => {
    try {
        const { session } = req.query;

        let query = supabase
            .from('past_executives')
            .select('*')
            .order('academic_session', { ascending: false })
            .order('rank_order', { ascending: true })
            .order('full_name', { ascending: true });

        if (session && session.trim()) {
            query = query.eq('academic_session', session.trim());
        }

        const { data, error } = await query;
        if (error) throw error;

        return successResponse(res, { executives: data || [] }, 'Past executives retrieved successfully');
    } catch (error) {
        console.error('Past executives fetch error:', error);
        return errorResponse(res, 'Failed to fetch past executives', 500, error);
    }
});

// ============================================
// 2. PUBLIC: GET DISTINCT SESSIONS LIST
// ============================================
router.get('/sessions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('past_executives')
            .select('academic_session, administration_name')
            .order('academic_session', { ascending: false });

        if (error) throw error;

        // Deduplicate sessions while preserving administration name
        const seen = new Set();
        const sessions = [];
        (data || []).forEach(item => {
            if (item.academic_session && !seen.has(item.academic_session)) {
                seen.add(item.academic_session);
                sessions.push({
                    session: item.academic_session,
                    administrationName: item.administration_name || `${item.academic_session} Administration`
                });
            }
        });

        return successResponse(res, { sessions }, 'Distinct sessions retrieved successfully');
    } catch (error) {
        console.error('Error fetching executive sessions:', error);
        return errorResponse(res, 'Failed to fetch sessions', 500, error);
    }
});

// ============================================
// 3. ADMIN: ADD PAST EXECUTIVE
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
    try {
        const {
            fullName,
            portfolio,
            academicSession,
            administrationName,
            department,
            photoUrl,
            linkedinUrl,
            githubUrl,
            twitterUrl,
            bio,
            rankOrder,
            isFeatured,
            levelOrSet,
            level_or_set
        } = req.body || {};

        if (!fullName || !fullName.trim() || !portfolio || !portfolio.trim() || !academicSession || !academicSession.trim()) {
            return errorResponse(res, 'Full name, portfolio, and academic session are required', 400);
        }

        const insertPayload = {
            full_name: fullName.trim(),
            portfolio: portfolio.trim(),
            academic_session: academicSession.trim(),
            administration_name: administrationName ? administrationName.trim() : null,
            department: department ? department.trim() : 'Computer Science',
            photo_url: photoUrl ? photoUrl.trim() : null,
            linkedin_url: linkedinUrl ? linkedinUrl.trim() : null,
            github_url: githubUrl ? githubUrl.trim() : null,
            twitter_url: twitterUrl ? twitterUrl.trim() : null,
            bio: bio ? bio.trim() : null,
            rank_order: parseInt(rankOrder, 10) || 10,
            is_featured: !!isFeatured,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const resolvedLevel = levelOrSet || level_or_set;
        if (resolvedLevel) {
            insertPayload.level_or_set = String(resolvedLevel).trim();
        }

        let { data, error } = await supabase
            .from('past_executives')
            .insert([insertPayload])
            .select()
            .single();

        // If level_or_set is not in DB schema, strip and retry
        if (error && (error.code === 'PGRST204' || String(error.message || '').includes('schema cache'))) {
            delete insertPayload.level_or_set;
            const retry = await supabase
                .from('past_executives')
                .insert([insertPayload])
                .select()
                .single();
            data = retry.data;
            error = retry.error;
        }

        if (error) throw error;

        await auditLog({
            action: 'past_executive_created',
            userId: req.userId,
            details: { name: fullName, portfolio, session: academicSession },
            ip: req.ip
        });

        return successResponse(res, { executive: data }, 'Past executive added successfully', 201);
    } catch (error) {
        console.error('Admin create past executive error:', error);
        return errorResponse(res, 'Failed to add past executive', 500, error);
    }
});

// ============================================
// 4. ADMIN: UPDATE PAST EXECUTIVE
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            fullName,
            portfolio,
            academicSession,
            administrationName,
            department,
            photoUrl,
            linkedinUrl,
            githubUrl,
            twitterUrl,
            bio,
            rankOrder,
            isFeatured,
            levelOrSet,
            level_or_set
        } = req.body || {};

        const updateData = { updated_at: new Date().toISOString() };
        if (fullName !== undefined) updateData.full_name = fullName.trim();
        if (portfolio !== undefined) updateData.portfolio = portfolio.trim();
        if (academicSession !== undefined) updateData.academic_session = academicSession.trim();
        if (administrationName !== undefined) updateData.administration_name = administrationName ? administrationName.trim() : null;
        if (department !== undefined) updateData.department = department ? department.trim() : 'Computer Science';
        if (photoUrl !== undefined) updateData.photo_url = photoUrl ? photoUrl.trim() : null;
        if (linkedinUrl !== undefined) updateData.linkedin_url = linkedinUrl ? linkedinUrl.trim() : null;
        if (githubUrl !== undefined) updateData.github_url = githubUrl ? githubUrl.trim() : null;
        if (twitterUrl !== undefined) updateData.twitter_url = twitterUrl ? twitterUrl.trim() : null;
        if (bio !== undefined) updateData.bio = bio ? bio.trim() : null;
        if (rankOrder !== undefined) updateData.rank_order = parseInt(rankOrder, 10) || 10;
        if (isFeatured !== undefined) updateData.is_featured = !!isFeatured;
        const resolvedLevel = levelOrSet !== undefined ? levelOrSet : level_or_set;
        if (resolvedLevel !== undefined) updateData.level_or_set = resolvedLevel ? String(resolvedLevel).trim() : null;

        let { data, error } = await supabase
            .from('past_executives')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        // If level_or_set is not in DB schema, strip and retry
        if (error && (error.code === 'PGRST204' || String(error.message || '').includes('schema cache'))) {
            delete updateData.level_or_set;
            const retry = await supabase
                .from('past_executives')
                .update(updateData)
                .eq('id', id)
                .select()
                .single();
            data = retry.data;
            error = retry.error;
        }

        if (error) throw error;

        await auditLog({
            action: 'past_executive_updated',
            userId: req.userId,
            details: { id, updateData },
            ip: req.ip
        });

        return successResponse(res, { executive: data }, 'Past executive updated successfully');
    } catch (error) {
        console.error('Admin update past executive error:', error);
        return errorResponse(res, 'Failed to update past executive', 500, error);
    }
});

// ============================================
// 5. ADMIN: DELETE PAST EXECUTIVE
// ============================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('past_executives')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await auditLog({
            action: 'past_executive_deleted',
            userId: req.userId,
            details: { id },
            ip: req.ip
        });

        return successResponse(res, null, 'Past executive removed successfully');
    } catch (error) {
        console.error('Admin delete past executive error:', error);
        return errorResponse(res, 'Failed to delete past executive', 500, error);
    }
});

module.exports = router;
