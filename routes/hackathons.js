// backend/routes/hackathons.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, slugify } = require('../utils/helpers');

// ============================================
// 1. PUBLIC: GET ALL ACTIVE / UPCOMING HACKATHONS
// ============================================
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { event_type, status } = req.query;

        let query = supabase
            .from('hackathons')
            .select('*')
            .eq('is_published', true);

        if (event_type) query = query.eq('event_type', event_type);
        if (status) {
            query = query.eq('status', status);
        } else {
            // Default to non-completed ones first
            query = query.order('start_date', { ascending: true });
        }

        const { data: hackathons, error } = await query;
        if (error) throw error;

        // If user is logged in, attach their registration status
        let userRegistrations = [];
        if (req.userId) {
            const { data: regs } = await supabase
                .from('hackathon_registrations')
                .select('hackathon_id, id, team_name, status')
                .eq('leader_id', req.userId);
            userRegistrations = regs || [];
        }

        const regMap = new Map(userRegistrations.map(r => [r.hackathon_id, r]));

        const results = (hackathons || []).map(h => ({
            ...h,
            userRegistration: regMap.get(h.id) || null
        }));

        return successResponse(res, { hackathons: results }, 'Hackathons retrieved successfully');
    } catch (error) {
        console.error('Error fetching hackathons:', error);
        return errorResponse(res, 'Failed to fetch hackathons', 500, error);
    }
});

// ============================================
// 2. PUBLIC: GET PAST HACKATHONS WITH HALL OF FAME WINNERS
// ============================================
router.get('/past', async (req, res) => {
    try {
        const { data: pastHackathons, error: hError } = await supabase
            .from('hackathons')
            .select(`
                id,
                title,
                slug,
                tagline,
                banner_url,
                event_type,
                start_date,
                end_date,
                prize_pool,
                submissions:hackathon_submissions (
                    id,
                    project_title,
                    tagline,
                    description,
                    github_url,
                    demo_url,
                    tech_stack,
                    is_winner,
                    award_title,
                    ranking,
                    registration:hackathon_registrations (
                        team_name,
                        team_members
                    )
                )
            `)
            .eq('is_published', true)
            .eq('status', 'completed')
            .order('end_date', { ascending: false });

        if (hError) throw hError;

        // Organize submissions so winners appear first
        const formatted = (pastHackathons || []).map(h => {
            const winners = (h.submissions || [])
                .filter(s => s.is_winner)
                .sort((a, b) => (a.ranking || 99) - (b.ranking || 99));

            const generalProjects = (h.submissions || [])
                .filter(s => !s.is_winner);

            return {
                id: h.id,
                title: h.title,
                slug: h.slug,
                tagline: h.tagline,
                banner_url: h.banner_url,
                event_type: h.event_type,
                start_date: h.start_date,
                end_date: h.end_date,
                prize_pool: h.prize_pool,
                winners,
                projectCount: (h.submissions || []).length,
                otherProjects: generalProjects.slice(0, 6) // sample of other submissions
            };
        });

        return successResponse(res, { pastHackathons: formatted }, 'Past hackathons and winners retrieved');
    } catch (error) {
        console.error('Error fetching past hackathons:', error);
        return errorResponse(res, 'Failed to fetch past hackathons', 500, error);
    }
});

// ============================================
// 2B. PUBLIC: GET TEAMS OPEN TO COLLABORATION
// ============================================
router.get('/open-teams', async (req, res) => {
    try {
        const { hackathon_id } = req.query;

        let query = supabase
            .from('hackathon_registrations')
            .select(`
                id,
                team_name,
                track_selected,
                team_members,
                is_looking_for_members,
                hackathon_id,
                status,
                created_at,
                hackathons:hackathon_id (
                    id,
                    title,
                    event_type,
                    status
                )
            `)
            .eq('is_looking_for_members', true)
            .eq('status', 'registered')
            .order('created_at', { ascending: false });

        if (hackathon_id) {
            query = query.eq('hackathon_id', hackathon_id);
        }

        const { data: teams, error } = await query;
        if (error) throw error;

        return successResponse(res, { openTeams: teams || [] }, 'Open teams retrieved successfully');
    } catch (error) {
        console.error('Error fetching open teams:', error);
        return errorResponse(res, 'Failed to fetch open teams', 500, error);
    }
});

// ============================================
// 3. PUBLIC: GET SPECIFIC HACKATHON DETAILS
// ============================================
router.get('/:idOrSlug', optionalAuth, async (req, res) => {
    try {
        const { idOrSlug } = req.params;

        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

        let query = supabase.from('hackathons').select('*');
        if (isUUID) {
            query = query.eq('id', idOrSlug);
        } else {
            query = query.eq('slug', idOrSlug);
        }

        const { data: hackathon, error } = await query.maybeSingle();
        if (error) throw error;
        if (!hackathon) return errorResponse(res, 'Hackathon not found', 404);

        // Fetch registered teams (for matchmaking / team finding)
        const { data: teams } = await supabase
            .from('hackathon_registrations')
            .select('id, team_name, is_looking_for_members, track_selected, team_members')
            .eq('hackathon_id', hackathon.id)
            .eq('status', 'registered');

        let userRegistration = null;
        let userSubmission = null;

        if (req.userId) {
            const { data: myReg } = await supabase
                .from('hackathon_registrations')
                .select('*')
                .eq('hackathon_id', hackathon.id)
                .eq('leader_id', req.userId)
                .maybeSingle();

            userRegistration = myReg;

            if (myReg) {
                const { data: mySub } = await supabase
                    .from('hackathon_submissions')
                    .select('*')
                    .eq('registration_id', myReg.id)
                    .maybeSingle();
                userSubmission = mySub;
            }
        }

        return successResponse(res, {
            hackathon,
            registeredTeamsCount: (teams || []).length,
            lookingForMembers: (teams || []).filter(t => t.is_looking_for_members),
            userRegistration,
            userSubmission
        }, 'Hackathon details retrieved successfully');
    } catch (error) {
        console.error('Error fetching hackathon details:', error);
        return errorResponse(res, 'Failed to fetch hackathon details', 500, error);
    }
});

// ============================================
// 4. STUDENT: REGISTER TEAM / INDIVIDUAL
// ============================================
router.post('/:id/register', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            teamName,
            trackSelected,
            isLookingForMembers,
            teamMembers
        } = req.body || {};

        if (!teamName || !teamName.trim()) {
            return errorResponse(res, 'Team name is required', 400);
        }

        // Validate hackathon is open for registration
        const { data: hackathon, error: hError } = await supabase
            .from('hackathons')
            .select('id, title, registration_deadline, max_team_size, min_team_size, status, is_published')
            .eq('id', id)
            .maybeSingle();

        if (hError) throw hError;
        if (!hackathon || !hackathon.is_published) {
            return errorResponse(res, 'Hackathon not found or not published', 404);
        }

        const now = new Date();
        if (new Date(hackathon.registration_deadline) < now) {
            return errorResponse(res, 'Registration deadline for this event has passed', 400);
        }

        // Validate team member array bounds
        const members = Array.isArray(teamMembers) ? teamMembers : [];
        if (members.length + 1 > (hackathon.max_team_size || 4)) {
            return errorResponse(res, `Team size cannot exceed ${hackathon.max_team_size} members`, 400);
        }

        // Insert registration
        const { data: reg, error: regError } = await supabase
            .from('hackathon_registrations')
            .insert([{
                hackathon_id: id,
                leader_id: req.userId,
                team_name: teamName.trim(),
                track_selected: trackSelected || null,
                is_looking_for_members: !!isLookingForMembers,
                team_members: members,
                status: 'registered'
            }])
            .select()
            .single();

        if (regError) {
            if (regError.code === '23505') {
                return errorResponse(res, 'You are already registered for this hackathon', 409);
            }
            throw regError;
        }

        await auditLog({
            action: 'hackathon_registered',
            userId: req.userId,
            details: { hackathon_id: id, team_name: teamName },
            ip: req.ip
        });

        return successResponse(res, { registration: reg }, 'Successfully registered for hackathon!', 201);
    } catch (error) {
        console.error('Hackathon registration error:', error);
        return errorResponse(res, 'Failed to register for hackathon', 500, error);
    }
});

// ============================================
// 5. STUDENT: SUBMIT PROJECT
// ============================================
router.post('/:id/submit', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            projectTitle,
            tagline,
            description,
            githubUrl,
            demoUrl,
            videoUrl,
            pitchDeckUrl,
            techStack
        } = req.body || {};

        if (!projectTitle || !projectTitle.trim() || !description) {
            return errorResponse(res, 'Project title and description are required', 400);
        }

        // Find user's registration
        const { data: reg, error: regError } = await supabase
            .from('hackathon_registrations')
            .select('id, hackathon_id, leader_id')
            .eq('hackathon_id', id)
            .eq('leader_id', req.userId)
            .maybeSingle();

        if (regError) throw regError;
        if (!reg) {
            return errorResponse(res, 'You must register for this hackathon before submitting', 403);
        }

        // Insert or Update submission
        const payload = {
            hackathon_id: id,
            registration_id: reg.id,
            project_title: projectTitle.trim(),
            tagline: tagline ? tagline.trim() : null,
            description: description.trim(),
            github_url: githubUrl ? githubUrl.trim() : null,
            demo_url: demoUrl ? demoUrl.trim() : null,
            video_url: videoUrl ? videoUrl.trim() : null,
            pitch_deck_url: pitchDeckUrl ? pitchDeckUrl.trim() : null,
            tech_stack: Array.isArray(techStack) ? techStack : [],
            updated_at: new Date().toISOString()
        };

        const { data: submission, error: subError } = await supabase
            .from('hackathon_submissions')
            .upsert(payload, { onConflict: 'registration_id' })
            .select()
            .single();

        if (subError) throw subError;

        // Update registration status to 'submitted'
        await supabase
            .from('hackathon_registrations')
            .update({ status: 'submitted' })
            .eq('id', reg.id);

        await auditLog({
            action: 'hackathon_project_submitted',
            userId: req.userId,
            details: { hackathon_id: id, project_title: projectTitle },
            ip: req.ip
        });

        return successResponse(res, { submission }, 'Project submitted successfully!');
    } catch (error) {
        console.error('Project submission error:', error);
        return errorResponse(res, 'Failed to submit project', 500, error);
    }
});

// ============================================
// 6. ADMIN: CREATE / EDIT HACKATHON
// ============================================
router.post('/admin/create', authenticate, requireAdmin, async (req, res) => {
    try {
        const {
            title,
            tagline,
            description,
            bannerUrl,
            eventType,
            mode,
            location,
            startDate,
            endDate,
            registrationDeadline,
            prizePool,
            maxTeamSize,
            minTeamSize,
            tracks,
            milestones,
            rules,
            judgingCriteria,
            isPublished,
            status
        } = req.body || {};

        if (!title || !startDate || !endDate || !registrationDeadline) {
            return errorResponse(res, 'Title, start date, end date, and registration deadline are required', 400);
        }

        const slug = slugify(title) + '-' + Date.now().toString(36);

        const { data: hackathon, error } = await supabase
            .from('hackathons')
            .insert([{
                title: title.trim(),
                slug,
                tagline: tagline || null,
                description: description || null,
                banner_url: bannerUrl || null,
                event_type: eventType || 'hackathon',
                mode: mode || 'hybrid',
                location: location || 'TAU Campus / Online',
                start_date: startDate,
                end_date: endDate,
                registration_deadline: registrationDeadline,
                prize_pool: prizePool || null,
                max_team_size: parseInt(maxTeamSize, 10) || 4,
                min_team_size: parseInt(minTeamSize, 10) || 1,
                tracks: Array.isArray(tracks) ? tracks : [],
                milestones: Array.isArray(milestones) ? milestones : [],
                rules: rules || null,
                judging_criteria: Array.isArray(judgingCriteria) ? judgingCriteria : [],
                is_published: isPublished !== false,
                status: status || 'upcoming',
                created_by: req.userId
            }])
            .select()
            .single();

        if (error) throw error;

        return successResponse(res, { hackathon }, 'Hackathon created successfully', 201);
    } catch (error) {
        console.error('Admin create hackathon error:', error);
        return errorResponse(res, 'Failed to create hackathon', 500, error);
    }
});

// ============================================
// 7. ADMIN: ASSIGN WINNER / HALL OF FAME
// ============================================
router.post('/admin/submissions/:subId/winner', authenticate, requireAdmin, async (req, res) => {
    try {
        const { subId } = req.params;
        const { isWinner, awardTitle, ranking, feedback } = req.body || {};

        const { data: updated, error } = await supabase
            .from('hackathon_submissions')
            .update({
                is_winner: !!isWinner,
                award_title: awardTitle || null,
                ranking: ranking ? parseInt(ranking, 10) : null,
                feedback: feedback || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', subId)
            .select(`
                *,
                registration:hackathon_registrations(team_name)
            `)
            .single();

        if (error) throw error;

        await auditLog({
            action: 'hackathon_winner_assigned',
            userId: req.userId,
            details: { submission_id: subId, award: awardTitle, ranking },
            ip: req.ip
        });

        return successResponse(res, { submission: updated }, 'Winner status updated successfully');
    } catch (error) {
        console.error('Assign winner error:', error);
        return errorResponse(res, 'Failed to update winner status', 500, error);
    }
});

// ============================================
// 8. ADMIN: GET ALL REGISTRATIONS & SUBMISSIONS FOR AN EVENT
// ============================================
router.get('/admin/:id/participants', authenticate, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: registrations, error: regError } = await supabase
            .from('hackathon_registrations')
            .select(`
                *,
                submission:hackathon_submissions (*)
            `)
            .eq('hackathon_id', id)
            .order('created_at', { ascending: false });

        if (regError) throw regError;

        return successResponse(res, { registrations }, 'Participants and submissions retrieved');
    } catch (error) {
        console.error('Admin get participants error:', error);
        return errorResponse(res, 'Failed to retrieve participants', 500, error);
    }
});

module.exports = router;
