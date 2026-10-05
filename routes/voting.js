// backend/routes/voting.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// GET ALL ACTIVE VOTING POSITIONS & CANDIDATES
// ============================================
router.get('/positions', authenticate, async (req, res) => {
    try {
        const now = new Date().toISOString();

        // Fetch active positions
        const { data: positions, error: posError } = await supabase
            .from('voting_positions')
            .select(`
                id,
                title,
                description,
                display_order,
                is_active,
                voting_start,
                voting_end,
                candidates:voting_candidates (
                    id,
                    display_name,
                    bio,
                    manifesto,
                    photo_url,
                    is_active
                )
            `)
            .eq('is_active', true)
            .order('display_order', { ascending: true });

        if (posError) throw posError;

        // Check which positions current user has already voted for
        const { data: myVotes, error: votesError } = await supabase
            .from('votes')
            .select('position_id, candidate_id, voted_at')
            .eq('voter_id', req.userId);

        if (votesError) throw votesError;

        const votedPositionMap = new Map();
        (myVotes || []).forEach(v => {
            votedPositionMap.set(v.position_id, {
                candidateId: v.candidate_id,
                votedAt: v.voted_at
            });
        });

        // Enrich positions with voter status & voting window
        const enrichedPositions = (positions || []).map(pos => {
            const hasStarted = !pos.voting_start || new Date(pos.voting_start) <= new Date(now);
            const hasEnded = pos.voting_end && new Date(pos.voting_end) < new Date(now);
            const isVotingOpen = hasStarted && !hasEnded;
            const userVote = votedPositionMap.get(pos.id) || null;

            return {
                ...pos,
                isVotingOpen,
                hasVoted: !!userVote,
                userVote: userVote ? { candidateId: userVote.candidateId } : null,
                candidates: (pos.candidates || []).filter(c => c.is_active)
            };
        });

        return successResponse(res, { positions: enrichedPositions }, 'Voting positions retrieved successfully');
    } catch (error) {
        console.error('Error fetching voting positions:', error);
        return errorResponse(res, 'Failed to fetch voting positions', 500, error);
    }
});

// ============================================
// CAST A VOTE (Student)
// ============================================
router.post('/vote', authenticate, async (req, res) => {
    try {
        const { positionId, candidateId } = req.body || {};

        if (!positionId || !candidateId) {
            return errorResponse(res, 'Both positionId and candidateId are required', 400);
        }

        // 1. Verify position exists and voting is open
        const { data: position, error: posError } = await supabase
            .from('voting_positions')
            .select('id, title, is_active, voting_start, voting_end')
            .eq('id', positionId)
            .maybeSingle();

        if (posError) throw posError;
        if (!position || !position.is_active) {
            return errorResponse(res, 'Voting position not found or is inactive', 404);
        }

        const now = new Date();
        if (position.voting_start && new Date(position.voting_start) > now) {
            return errorResponse(res, 'Voting for this position has not started yet', 400);
        }
        if (position.voting_end && new Date(position.voting_end) < now) {
            return errorResponse(res, 'Voting for this position has already closed', 400);
        }

        // 2. Verify candidate exists for this position
        const { data: candidate, error: candError } = await supabase
            .from('voting_candidates')
            .select('id, is_active')
            .eq('id', candidateId)
            .eq('position_id', positionId)
            .maybeSingle();

        if (candError) throw candError;
        if (!candidate || !candidate.is_active) {
            return errorResponse(res, 'Candidate not found or inactive for this position', 404);
        }

        // 3. Insert vote (table enforces UNIQUE(position_id, voter_id))
        const { data: vote, error: voteError } = await supabase
            .from('votes')
            .insert([{
                position_id: positionId,
                candidate_id: candidateId,
                voter_id: req.userId,
                voted_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (voteError) {
            // Postgres unique violation code 23505
            if (voteError.code === '23505' || voteError.message?.includes('duplicate key')) {
                return errorResponse(res, 'You have already voted for this position', 409);
            }
            throw voteError;
        }

        // 4. Increment candidate vote_count (best-effort)
        try {
            await supabase.rpc('increment_candidate_votes', { candidate_id: candidateId });
        } catch (_) {
            // Fallback manual count increment if RPC not defined
            const { data: candRow } = await supabase
                .from('voting_candidates')
                .select('vote_count')
                .eq('id', candidateId)
                .single();
            if (candRow) {
                await supabase
                    .from('voting_candidates')
                    .update({ vote_count: (candRow.vote_count || 0) + 1 })
                    .eq('id', candidateId);
            }
        }

        // Audit log vote event
        await auditLog({
            action: 'vote_cast',
            userId: req.userId,
            details: {
                position_id: positionId,
                position_title: position.title,
                candidate_id: candidateId
            },
            ip: req.ip
        });

        return successResponse(res, { voteId: vote.id }, 'Vote cast successfully', 201);
    } catch (error) {
        console.error('Error casting vote:', error);
        return errorResponse(res, 'Failed to cast vote', 500, error);
    }
});

// ============================================
// GET RESULTS / TALLY (Admin Only or After Voting Closed)
// ============================================
router.get('/results', authenticate, requireAdmin, async (req, res) => {
    try {
        const { data: positions, error: posError } = await supabase
            .from('voting_positions')
            .select(`
                id,
                title,
                is_active,
                voting_start,
                voting_end,
                candidates:voting_candidates (
                    id,
                    display_name,
                    photo_url,
                    vote_count
                )
            `)
            .order('display_order', { ascending: true });

        if (posError) throw posError;

        // Calculate total votes per position
        const results = (positions || []).map(pos => {
            const candidates = pos.candidates || [];
            const totalVotes = candidates.reduce((sum, c) => sum + (c.vote_count || 0), 0);
            return {
                positionId: pos.id,
                positionTitle: pos.title,
                totalVotes,
                candidates: candidates.map(c => ({
                    id: c.id,
                    name: c.display_name,
                    voteCount: c.vote_count || 0,
                    percentage: totalVotes > 0 ? Number(((c.vote_count || 0) / totalVotes * 100).toFixed(1)) : 0
                })).sort((a, b) => b.voteCount - a.voteCount)
            };
        });

        return successResponse(res, { results }, 'Voting results retrieved successfully');
    } catch (error) {
        console.error('Error fetching voting results:', error);
        return errorResponse(res, 'Failed to fetch voting results', 500, error);
    }
});

module.exports = router;