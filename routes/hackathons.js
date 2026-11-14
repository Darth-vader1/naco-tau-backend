// backend/routes/hackathons.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, slugify } = require('../utils/helpers');
const { triggerAutoContentBroadcast, sendHackathonTeamAdminNotificationEmail } = require('../services/email');
const rateLimit = require('express-rate-limit');

// ============================================
// 1. PUBLIC: GET ALL ACTIVE / UPCOMING HACKATHONS
// ============================================
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { event_type, status } = req.query;

        let query = supabase
            .from('hackathons')
            .select('*')
            .neq('is_published', false);

        if (event_type) {
            const et = event_type.trim().toLowerCase();
            if (et === 'hackathon') {
                query = query.or('event_type.ilike.%hackathon%,event_type.is.null');
            } else {
                query = query.ilike('event_type', `%${et}%`);
            }
        }

        if (status) {
            const st = status.trim().toLowerCase();
            if (st === 'voting' || st === 'judging') {
                query = query.in('status', ['voting', 'judging']);
            } else if (st === 'completed' || st === 'past') {
                query = query.in('status', ['completed', 'past']);
            } else {
                query = query.eq('status', st);
            }
        } else {
            // Default to non-concluded competitions (exclude completed and past)
            query = query.not('status', 'in', '("completed","past")').order('start_date', { ascending: true });
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
            .in('status', ['completed', 'past'])
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
// ============================================
// TEAM ROSTER HELPERS
// ============================================
const TEAM_META_ROWS = ['[ROLE_REQ]', '[LEADER_META]'];
const normEmail = (e) => String(e || '').trim().toLowerCase();

/**
 * Who is already on a team in this hackathon, by account id and by email.
 * The team led by `skipLeaderId` (the caller's own team) is left out, so a
 * leader editing their team doesn't clash with their own teammates.
 */
async function loadTakenRoster(hackathonId, skipLeaderId) {
    const { data: regs, error } = await supabase
        .from('hackathon_registrations')
        .select('id, team_name, leader_id, team_members')
        .eq('hackathon_id', hackathonId);
    if (error) throw error;

    const byUser = new Map();  // user_id -> team name
    const byEmail = new Map(); // email   -> team name
    for (const r of regs || []) {
        if (skipLeaderId && r.leader_id === skipLeaderId) continue;
        if (r.leader_id) byUser.set(r.leader_id, r.team_name);
        for (const m of Array.isArray(r.team_members) ? r.team_members : []) {
            if (!m || typeof m !== 'object') continue;
            if (m.name === '[LEADER_META]') { if (m.email) byEmail.set(normEmail(m.email), r.team_name); continue; }
            if (TEAM_META_ROWS.includes(m.name)) continue;
            if (m.user_id) byUser.set(m.user_id, r.team_name);
            if (m.email) byEmail.set(normEmail(m.email), r.team_name);
        }
    }
    return { byUser, byEmail };
}

// Search as you type: one search per keystroke pause, so allow a brisk pace
// per student while stopping scraping of the student list.
const teammateSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || req.ip,
    message: { success: false, error: 'Too many searches. Please slow down.' },
    validate: { trustProxy: false }
});

// ============================================
// STUDENT: FIND TEAMMATES (search as you type)
// ============================================
// Returns at most 8 students whose name matches at least 3 typed letters.
// Only name, department and level are shown (no email or phone). Leaves
// out: the caller, private profiles, inactive accounts, and anyone already
// on another team in this hackathon.
router.get('/:id/teammate-search', authenticate, teammateSearchLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        const q = String(req.query.q || '').replace(/[,()*%\\":.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
        if (q.length < 3) return successResponse(res, { results: [] }, 'Type at least 3 letters');

        const taken = await loadTakenRoster(id, req.userId);

        const { data, error } = await supabase
            .from('students_with_current_level')
            .select('user_id, name, first_name, last_name, email, department, current_level, profile_picture_url')
            .eq('status', 'active')
            .in('visibility', ['students-only', 'public'])
            .neq('user_id', req.userId)
            .or(`name.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
            .order('name', { ascending: true })
            .limit(25);
        if (error) throw error;

        const results = (data || [])
            .filter(s => s.user_id && !taken.byUser.has(s.user_id) && !taken.byEmail.has(normEmail(s.email)))
            .slice(0, 8)
            .map(s => ({
                user_id: s.user_id,
                name: s.name || `${s.first_name || ''} ${s.last_name || ''}`.trim(),
                department: s.department || null,
                level: s.current_level || null,
                avatar: s.profile_picture_url || null
            }));

        return successResponse(res, { results }, 'Matching students');
    } catch (error) {
        console.error('Teammate search error:', error);
        return errorResponse(res, 'Could not search students right now', 500);
    }
});

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

        const st = (hackathon.status || 'upcoming').toLowerCase();
        if (['voting', 'judging', 'completed', 'past'].includes(st)) {
            return errorResponse(res, `Registration is closed because this competition is ${['voting', 'judging'].includes(st) ? 'in judging/voting' : 'concluded'}`, 400);
        }

        const now = new Date();
        if (hackathon.registration_deadline && new Date(hackathon.registration_deadline) < now) {
            return errorResponse(res, 'Registration deadline for this event has passed', 400);
        }

        // Validate team size. team_members can also carry internal rows
        // ([ROLE_REQ], [LEADER_META]); the leader is counted once, never again
        // as a teammate even if they listed themselves.
        const leaderEmail = String(req.user?.email || '').trim().toLowerCase();
        const META_ROWS = ['[ROLE_REQ]', '[LEADER_META]'];
        let members = (Array.isArray(teamMembers) ? teamMembers : []).filter(m => {
            if (!m || typeof m !== 'object') return false;
            if (META_ROWS.includes(m.name)) return true; // keep internal rows as stored
            const email = String(m.email || '').trim().toLowerCase();
            if (m.user_id && String(m.user_id) === String(req.userId)) return false; // the leader picked themself
            return !(leaderEmail && email && email === leaderEmail); // drop the leader listed as a teammate
        });

        // Teammates picked from the search are linked to their account: their
        // name and email come from it (no typos), and they must be active students.
        const linkedIds = [...new Set(members
            .filter(m => !META_ROWS.includes(m.name) && m.user_id)
            .map(m => String(m.user_id)))];
        if (linkedIds.length) {
            const { data: accounts, error: accErr } = await supabase
                .from('students')
                .select('user_id, name, first_name, last_name, email, status')
                .in('user_id', linkedIds);
            if (accErr) throw accErr;
            const byId = new Map((accounts || []).map(a => [String(a.user_id), a]));
            for (const m of members) {
                if (META_ROWS.includes(m.name) || !m.user_id) continue;
                const acct = byId.get(String(m.user_id));
                if (!acct || (acct.status && acct.status !== 'active')) {
                    return errorResponse(res, `${m.name || 'A selected teammate'} couldn't be found as an active student. Remove them and pick again, or add them manually.`, 400);
                }
                m.user_id = acct.user_id;
                m.name = acct.name || `${acct.first_name || ''} ${acct.last_name || ''}`.trim() || m.name;
                m.email = acct.email || m.email || '';
            }
            // A linked account might be the leader's own (matched by email above only if typed).
            members = members.filter(m => META_ROWS.includes(m.name) || normEmail(m.email) !== leaderEmail);
        }

        // Each person once within the team
        const seenPeople = new Set();
        for (const m of members) {
            if (META_ROWS.includes(m.name)) continue;
            const key = m.user_id ? `u:${m.user_id}` : (m.email ? `e:${normEmail(m.email)}` : `n:${String(m.name || '').trim().toLowerCase()}`);
            if (seenPeople.has(key)) {
                return errorResponse(res, `${m.name || 'A teammate'} is listed more than once. Remove the extra row.`, 400);
            }
            seenPeople.add(key);
        }

        // Nobody can be on two teams in the same hackathon (the leader included)
        const takenRoster = await loadTakenRoster(id, req.userId);
        const leaderTeam = takenRoster.byUser.get(req.userId) || takenRoster.byEmail.get(leaderEmail);
        if (leaderTeam) {
            return errorResponse(res, `You're already listed on team "${leaderTeam}" in this hackathon, so you can't lead another team.`, 409);
        }
        for (const m of members) {
            if (META_ROWS.includes(m.name)) continue;
            const team = (m.user_id && takenRoster.byUser.get(m.user_id)) || (m.email && takenRoster.byEmail.get(normEmail(m.email)));
            if (team) {
                return errorResponse(res, `${m.name || 'A teammate'} is already on team "${team}" in this hackathon.`, 409);
            }
        }

        const teammateCount = members.filter(m => !META_ROWS.includes(m.name)).length;
        const maxSize = hackathon.max_team_size || 4;
        if (teammateCount + 1 > maxSize) {
            return errorResponse(res, `Team size cannot exceed ${maxSize} members (you plus ${maxSize - 1} teammates).`, 400);
        }

        const trimmedName = teamName.trim();

        // 1. Validate unique team name for this hackathon
        const { data: existingTeam } = await supabase
            .from('hackathon_registrations')
            .select('id, leader_id')
            .eq('hackathon_id', id)
            .ilike('team_name', trimmedName)
            .maybeSingle();

        if (existingTeam && existingTeam.leader_id !== req.userId) {
            return errorResponse(res, `The team name "${trimmedName}" is already taken for this event. Please choose another unique name.`, 409);
        }

        // 2. Check if user is updating their existing registration
        const { data: existingUserReg } = await supabase
            .from('hackathon_registrations')
            .select('id, status')
            .eq('hackathon_id', id)
            .eq('leader_id', req.userId)
            .maybeSingle();

        if (existingUserReg) {
            const { data: updatedReg, error: updateError } = await supabase
                .from('hackathon_registrations')
                .update({
                    team_name: trimmedName,
                    track_selected: trackSelected || null,
                    is_looking_for_members: !!isLookingForMembers,
                    team_members: members,
                    updated_at: new Date()
                })
                .eq('id', existingUserReg.id)
                .select()
                .single();

            if (updateError) throw updateError;

            await auditLog({
                action: 'hackathon_registration_updated',
                userId: req.userId,
                details: { hackathon_id: id, team_name: trimmedName },
                ip: req.ip
            });

            return successResponse(res, { registration: updatedReg }, 'Team registration updated successfully!');
        }

        // 3. New registration
        const { data: reg, error: regError } = await supabase
            .from('hackathon_registrations')
            .insert([{
                hackathon_id: id,
                leader_id: req.userId,
                team_name: trimmedName,
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
            details: { hackathon_id: id, team_name: trimmedName },
            ip: req.ip
        });

        // Tell the admins about the new team. Awaited (bounded) so a serverless
        // platform can't freeze the function before it is sent; never blocks or
        // fails the registration itself.
        try {
            const { data: leaderProfile } = await supabase
                .from('students')
                .select('name, first_name, last_name, email, matric_no, phone, department, current_level')
                .eq('user_id', req.userId)
                .maybeSingle();
            const teammates = members.filter(m => !META_ROWS.includes(m.name));
            await Promise.race([
                sendHackathonTeamAdminNotificationEmail({
                    hackathon,
                    registration: reg,
                    leader: leaderProfile || { email: req.user?.email },
                    teammates
                }),
                new Promise(resolve => setTimeout(resolve, 8000))
            ]);
        } catch (notifyErr) {
            console.warn('[hackathons] new-team admin email failed (non-fatal):', notifyErr?.message || notifyErr);
        }

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

        const shouldSendEmail = req.body.send_email !== false && req.body.send_email !== 'false' && req.body.sendEmail !== false;
        if (hackathon && shouldSendEmail) {
            triggerAutoContentBroadcast('hackathons', hackathon);
        } else if (hackathon && !shouldSendEmail) {
            console.log('[hackathons/POST] Skipped email broadcast because send_email is false');
        }

        return successResponse(res, { hackathon }, 'Hackathon created successfully', 201);
    } catch (error) {
        console.error('Admin create hackathon error:', error);
        return errorResponse(res, 'Failed to create hackathon', 500, error);
    }
});

// ============================================
// 6B. ADMIN: UPDATE HACKATHON STATUS
// ============================================
router.patch('/admin/:id/status', authenticate, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body || {};

        const validStatuses = ['upcoming', 'ongoing', 'voting', 'judging', 'completed', 'past'];
        if (!status || !validStatuses.includes(status.trim().toLowerCase())) {
            return errorResponse(res, `Invalid status. Allowed values: ${validStatuses.join(', ')}`, 400);
        }

        const normalizedStatus = status.trim().toLowerCase();

        const { data: updated, error } = await supabase
            .from('hackathons')
            .update({
                status: normalizedStatus,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        await auditLog({
            action: 'hackathon_status_updated',
            userId: req.userId,
            details: { hackathon_id: id, new_status: normalizedStatus },
            ip: req.ip
        });

        return successResponse(res, { hackathon: updated }, `Status updated to ${normalizedStatus}`);
    } catch (error) {
        console.error('Admin update status error:', error);
        return errorResponse(res, 'Failed to update competition status', 500, error);
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

        // Enrich with leader student profiles
        const leaderIds = (registrations || []).map(r => r.leader_id).filter(Boolean);
        if (leaderIds.length > 0) {
            let students = null;
            try {
                const { data } = await supabase
                    .from('students_with_current_level')
                    .select('*')
                    .in('user_id', leaderIds);
                if (data && data.length) students = data;
            } catch (_) {}

            if (!students || students.length === 0) {
                const { data } = await supabase
                    .from('students')
                    .select('*')
                    .in('user_id', leaderIds);
                students = data || [];
            }

            const studentMap = new Map();
            (students || []).forEach(s => {
                if (s.user_id) studentMap.set(s.user_id, s);
                if (s.id) studentMap.set(s.id, s);
            });

            (registrations || []).forEach(r => {
                r.leaderProfile = studentMap.get(r.leader_id) || null;
            });
        }

        return successResponse(res, { registrations }, 'Participants and submissions retrieved');
    } catch (error) {
        console.error('Admin get participants error:', error);
        return errorResponse(res, 'Failed to retrieve participants', 500, error);
    }
});

module.exports = router;
