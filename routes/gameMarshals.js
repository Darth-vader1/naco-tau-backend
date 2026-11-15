// routes/gameMarshals.js
// Game marshals: students an admin appoints (by school email) for one game
// event, between a start and an end time. While active they look up a ticket
// (scanned QR or typed ticket number) and mark plays as used.
//
//   Admin    GET    /api/game-marshals/admin/event/:eventId   marshals + plays report
//            POST   /api/game-marshals/admin/event/:eventId   appoint { email, starts_at, ends_at }
//            DELETE /api/game-marshals/admin/:id              remove early
//   Marshal  GET    /api/game-marshals/me                     my current/upcoming appointments
//            GET    /api/game-marshals/:eventId/ticket?code=  look up a ticket
//            POST   /api/game-marshals/:eventId/redeem        { code, item_id, plays }

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const { auditLog } = require('../middleware/audit');
const { registerLimiter } = require('../middleware/rateLimitInstances');
const { ticketNumberFor, parseTicketNumber } = require('../utils/tickets');
const { isUuid, loadEventItems, linesFromRow, describeGameOrder, playsOfItemIn } = require('../utils/games');
const { sendGameMarshalInviteEmail } = require('../services/email');

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/;
const MAX_APPOINTMENT_DAYS = 14;

// Marshals scan quickly at a busy station; stop guessing ticket numbers.
const marshalLimiter = registerLimiter('marshal', (store) => rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { success: false, error: 'Too many look-ups. Please slow down.' },
  validate: { trustProxy: false },
  store
}));

const nowIso = () => new Date().toISOString();
const displayName = (s) => (s && (s.name || `${s.first_name || ''} ${s.last_name || ''}`.trim())) || '';

/** The caller's live appointment for this event right now, or null. */
async function activeAppointment(eventId, userId) {
  const now = nowIso();
  const { data, error } = await supabase
    .from('game_marshals')
    .select('*')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .lte('starts_at', now)
    .gt('ends_at', now)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function requireMarshal(req, res) {
  const { eventId } = req.params;
  if (!isUuid(eventId)) { errorResponse(res, 'Invalid event', 400); return null; }
  const appt = await activeAppointment(eventId, req.userId);
  if (!appt) {
    errorResponse(res, 'You are not a game marshal for this event right now.', 403);
    return null;
  }
  return appt;
}

/** Find the paid registration for a ticket number at this event. */
async function findTicket(eventId, code) {
  const parsed = parseTicketNumber(code);
  if (!parsed) return { error: 'That is not a valid ticket number. It looks like NACOS-1A2B-3C4D5E.', status: 400 };
  if (String(eventId).substring(0, 4).toUpperCase() !== parsed.eventPart) {
    return { error: 'This ticket is for a different event.', status: 404 };
  }
  const { data, error } = await supabase
    .from('event_registrations')
    .select('*')
    .eq('event_id', eventId)
    .not('linked_payment_id', 'is', null);
  if (error) throw error;
  const matches = (data || []).filter(r =>
    String(r.linked_payment_id).toUpperCase().startsWith(parsed.paymentPart) &&
    (r.status || 'registered') !== 'cancelled');
  if (!matches.length) return { error: 'No paid ticket with that number for this event.', status: 404 };
  if (matches.length > 1) return { error: 'Two tickets share that number. Ask an admin to check it.', status: 409 };
  return { registration: matches[0] };
}

/** Games on a ticket with plays bought, used and left. */
async function ticketGames(registration) {
  const lines = await describeGameOrder(registration);
  if (!lines) return null;
  const { data: used, error } = await supabase
    .from('game_plays')
    .select('item_id, plays')
    .eq('registration_id', registration.id);
  if (error) throw error;
  return lines.map(l => {
    const usedPlays = (used || []).filter(u => u.item_id === l.item_id).reduce((s, u) => s + (u.plays || 0), 0);
    return { item_id: l.item_id, name: l.name, bought: l.plays, used: usedPlays, left: Math.max(0, l.plays - usedPlays) };
  });
}

async function buyerName(registration) {
  if (registration.guest_name) return { name: registration.guest_name, guest: true };
  if (!registration.user_id) return { name: 'Unknown buyer', guest: false };
  const { data } = await supabase
    .from('students')
    .select('name, first_name, last_name')
    .eq('user_id', registration.user_id)
    .maybeSingle();
  return { name: displayName(data) || 'Student', guest: false };
}

async function ticketView(eventId, registration) {
  const [games, buyer] = await Promise.all([ticketGames(registration), buyerName(registration)]);
  return {
    ticket_number: ticketNumberFor(eventId, registration.linked_payment_id),
    buyer: buyer.name,
    is_guest: buyer.guest,
    games: games || [],
    plays_left: (games || []).reduce((s, g) => s + g.left, 0)
  };
}

// ============================================
// MARSHAL
// ============================================

// My appointments that haven't ended (active now, or starting later).
router.get('/me', authenticate, async (req, res) => {
  try {
    const now = nowIso();
    const { data, error } = await supabase
      .from('game_marshals')
      .select('id, event_id, starts_at, ends_at')
      .eq('user_id', req.userId)
      .is('revoked_at', null)
      .gt('ends_at', now)
      .order('starts_at', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    let events = [];
    if (rows.length) {
      const { data: evs, error: evErr } = await supabase
        .from('events')
        .select('id, title, date, time, location')
        .in('id', rows.map(r => r.event_id));
      if (evErr) throw evErr;
      events = evs || [];
    }
    return successResponse(res, rows.map(r => ({
      id: r.id,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      active: r.starts_at <= now,
      event: events.find(e => e.id === r.event_id) || { id: r.event_id, title: 'Event' }
    })), 'Your game marshal appointments');
  } catch (error) {
    console.error('[marshals] me error:', error);
    return errorResponse(res, 'Could not load your marshal appointments', 500, error);
  }
});

router.get('/:eventId/ticket', authenticate, marshalLimiter, async (req, res) => {
  try {
    const appt = await requireMarshal(req, res);
    if (!appt) return;
    const found = await findTicket(req.params.eventId, req.query.code);
    if (found.error) return errorResponse(res, found.error, found.status);
    const view = await ticketView(req.params.eventId, found.registration);
    if (!view.games.length) return errorResponse(res, 'This ticket has no games on it.', 404);
    return successResponse(res, view, 'Ticket found');
  } catch (error) {
    console.error('[marshals] ticket lookup error:', error);
    return errorResponse(res, 'Could not look up that ticket', 500, error);
  }
});

router.post('/:eventId/redeem', authenticate, marshalLimiter, async (req, res) => {
  try {
    const appt = await requireMarshal(req, res);
    if (!appt) return;
    const { code, item_id: itemId } = req.body || {};
    const plays = req.body?.plays === undefined ? 1 : Number(req.body.plays);
    if (!isUuid(itemId)) return errorResponse(res, 'Pick a game.', 400);
    if (!Number.isInteger(plays) || plays < 1 || plays > 10) return errorResponse(res, 'Mark between 1 and 10 plays at a time.', 400);

    const found = await findTicket(req.params.eventId, code);
    if (found.error) return errorResponse(res, found.error, found.status);
    const reg = found.registration;
    const bought = playsOfItemIn(reg, itemId);
    if (!bought) return errorResponse(res, 'That game is not on this ticket.', 400);

    const { data: left, error } = await supabase.rpc('redeem_game_play', {
      p_registration_id: reg.id,
      p_item_id: itemId,
      p_plays: plays,
      p_bought: bought,
      p_marshal_id: appt.id,
      p_marshal_user_id: req.userId
    });
    if (error) {
      if (/NO_PLAYS_LEFT/.test(error.message || '')) return errorResponse(res, 'No plays left for this game on this ticket.', 409);
      if (/TICKET_NOT_FOUND/.test(error.message || '')) return errorResponse(res, 'Ticket not found.', 404);
      throw error;
    }

    await auditLog({
      action: 'game_play_marked',
      userId: req.userId,
      details: { event_id: req.params.eventId, registration_id: reg.id, item_id: itemId, plays, left },
      ip: req.ip
    });

    const view = await ticketView(req.params.eventId, reg);
    return successResponse(res, view, `${plays} play${plays > 1 ? 's' : ''} marked`);
  } catch (error) {
    console.error('[marshals] redeem error:', error);
    return errorResponse(res, 'Could not mark that play', 500, error);
  }
});

// ============================================
// ADMIN
// ============================================

router.get('/admin/event/:eventId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!isUuid(eventId)) return errorResponse(res, 'Invalid event', 400);
    const now = nowIso();

    const [marshalsRes, itemsAll, regsRes, playsRes] = await Promise.all([
      supabase.from('game_marshals').select('*').eq('event_id', eventId).order('starts_at', { ascending: false }),
      loadEventItems(eventId, { activeOnly: false }),
      supabase.from('event_registrations').select('*').eq('event_id', eventId).not('linked_payment_id', 'is', null),
      supabase.from('game_plays').select('registration_id, item_id, plays, marshal_user_id, created_at').eq('event_id', eventId)
    ]);
    for (const r of [marshalsRes, regsRes, playsRes]) if (r.error) throw r.error;

    const marshals = (marshalsRes.data || []).map(m => ({
      id: m.id, email: m.email, name: m.name, starts_at: m.starts_at, ends_at: m.ends_at,
      status: m.revoked_at ? 'removed' : (m.ends_at <= now ? 'ended' : (m.starts_at > now ? 'upcoming' : 'active'))
    }));

    const regs = (regsRes.data || []).filter(r => (r.status || 'registered') !== 'cancelled' && linesFromRow(r));
    const plays = playsRes.data || [];

    // Plays sold vs played, per game
    const games = itemsAll.map(it => {
      const sold = regs.reduce((s, r) => s + playsOfItemIn(r, it.id), 0);
      const played = plays.filter(p => p.item_id === it.id).reduce((s, p) => s + p.plays, 0);
      return { item_id: it.id, name: it.name, active: it.is_active !== false, sold, played, unused: Math.max(0, sold - played) };
    }).filter(g => g.sold > 0 || g.active);

    // Per buyer
    const userIds = [...new Set(regs.map(r => r.user_id).filter(Boolean))];
    let students = [];
    if (userIds.length) {
      const { data, error } = await supabase.from('students').select('user_id, name, first_name, last_name, email, matric_no').in('user_id', userIds);
      if (error) throw error;
      students = data || [];
    }
    const nameOf = (id) => (itemsAll.find(i => i.id === id) || {}).name || 'Game';
    const buyers = regs.map(r => {
      const s = students.find(x => x.user_id === r.user_id);
      const lines = linesFromRow(r) || [];
      return {
        ticket_number: ticketNumberFor(eventId, r.linked_payment_id),
        name: r.guest_name || displayName(s) || 'Student',
        email: r.guest_email || s?.email || '',
        matric_no: s?.matric_no || '',
        guest: !!r.guest_email,
        bought_at: r.registration_date || r.created_at || null,
        games: lines.map(l => {
          const used = plays.filter(p => p.registration_id === r.id && p.item_id === l.item_id).reduce((a, p) => a + p.plays, 0);
          return { name: l.name || nameOf(l.item_id), bought: l.plays, used, left: Math.max(0, l.plays - used) };
        })
      };
    });

    return successResponse(res, { marshals, games, buyers }, 'Game marshals and plays');
  } catch (error) {
    console.error('[marshals] admin report error:', error);
    return errorResponse(res, 'Could not load game marshals', 500, error);
  }
});

router.post('/admin/event/:eventId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!isUuid(eventId)) return errorResponse(res, 'Invalid event', 400);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return errorResponse(res, 'Enter a valid email address.', 400);

    const startsAt = new Date(req.body?.starts_at);
    const endsAt = new Date(req.body?.ends_at);
    if (isNaN(startsAt) || isNaN(endsAt)) return errorResponse(res, 'Set a start and end time.', 400);
    if (endsAt <= startsAt) return errorResponse(res, 'The end time must be after the start time.', 400);
    if (endsAt <= new Date()) return errorResponse(res, 'The end time is already in the past.', 400);
    if (endsAt - startsAt > MAX_APPOINTMENT_DAYS * 86400000) return errorResponse(res, `An appointment can last at most ${MAX_APPOINTMENT_DAYS} days.`, 400);

    const { data: event, error: evErr } = await supabase.from('events').select('id, title, date, time, location').eq('id', eventId).maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Event not found', 404);
    const items = await loadEventItems(eventId);
    if (!items.length) return errorResponse(res, 'Add games to this event first (green controller button).', 400);

    // Exact email match, case-insensitive (escape LIKE wildcards).
    const pattern = email.replace(/[\\%_]/g, c => '\\' + c);
    const { data: found, error: stErr } = await supabase
      .from('students')
      .select('user_id, name, first_name, last_name, email, status')
      .ilike('email', pattern)
      .limit(2);
    if (stErr) throw stErr;
    const student = (found || []).find(s => String(s.email).toLowerCase() === email);
    if (!student || !student.user_id) {
      return errorResponse(res, 'No student account uses that email. Ask them to sign up on the portal first.', 404);
    }
    if ((student.status || 'active') !== 'active') return errorResponse(res, 'That student account is not active.', 400);

    const { data: live, error: liveErr } = await supabase
      .from('game_marshals').select('id').eq('event_id', eventId).eq('user_id', student.user_id).is('revoked_at', null).limit(1);
    if (liveErr) throw liveErr;
    const row = {
      event_id: eventId,
      user_id: student.user_id,
      email: student.email,
      name: displayName(student) || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      appointed_by: req.userId
    };
    let saved;
    if (live && live.length) {
      // Already a marshal for this event: update the times.
      const { data, error } = await supabase.from('game_marshals').update(row).eq('id', live[0].id).select().single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('game_marshals').insert([row]).select().single();
      if (error) throw error;
      saved = data;
    }

    let emailed = false;
    try {
      const r = await Promise.race([
        sendGameMarshalInviteEmail({ student, event, startsAt: saved.starts_at, endsAt: saved.ends_at }),
        new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'timeout' }), 8000))
      ]);
      emailed = !!(r && r.success !== false);
    } catch (e) {
      console.warn('[marshals] invite email failed:', e.message);
    }

    await auditLog({
      action: live && live.length ? 'game_marshal_updated' : 'game_marshal_appointed',
      userId: req.userId,
      details: { event_id: eventId, marshal_user_id: student.user_id, email: student.email, starts_at: saved.starts_at, ends_at: saved.ends_at, emailed },
      ip: req.ip
    });

    return successResponse(res, { id: saved.id, email: saved.email, name: saved.name, starts_at: saved.starts_at, ends_at: saved.ends_at, emailed, updated: !!(live && live.length) },
      emailed ? 'Marshal appointed and invited by email' : 'Marshal appointed (the invitation email could not be sent)');
  } catch (error) {
    console.error('[marshals] appoint error:', error);
    return errorResponse(res, 'Could not appoint the marshal', 500, error);
  }
});

router.delete('/admin/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return errorResponse(res, 'Invalid marshal', 400);
    const { data, error } = await supabase
      .from('game_marshals')
      .update({ revoked_at: nowIso() })
      .eq('id', req.params.id)
      .is('revoked_at', null)
      .select('id, event_id, user_id, email');
    if (error) throw error;
    if (!data || !data.length) return errorResponse(res, 'Marshal not found or already removed', 404);
    await auditLog({ action: 'game_marshal_removed', userId: req.userId, details: data[0], ip: req.ip });
    return successResponse(res, { id: data[0].id }, 'Marshal removed');
  } catch (error) {
    console.error('[marshals] remove error:', error);
    return errorResponse(res, 'Could not remove the marshal', 500, error);
  }
});

module.exports = router;
