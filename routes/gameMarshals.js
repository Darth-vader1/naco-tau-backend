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
const { ticketNumberFor, parseTicketNumber, quantityOf } = require('../utils/tickets');
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
  const entries = Array.isArray(registration.entry_details) ? registration.entry_details : [];
  return lines.map(l => {
    const usedPlays = (used || []).filter(u => u.item_id === l.item_id).reduce((s, u) => s + (u.plays || 0), 0);
    const entry = entries.find(e => e && e.item_id === l.item_id);
    return { item_id: l.item_id, name: l.name, bought: l.plays, used: usedPlays, left: Math.max(0, l.plays - usedPlays), ...(entry ? { username: entry.username } : {}) };
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

const isMissingCheckins = (error) => !!error && (error.code === 'PGRST205' || error.code === '42P01' || error.code === 'PGRST202' ||
  /event_checkins|admit_tickets/.test(error.message || '') && /does not exist|could not find/i.test(error.message || ''));

/** Game events are run by marshals marking plays; other events by door check-in. */
async function eventMode(eventId) {
  const items = await loadEventItems(eventId);
  return items.length ? 'games' : 'checkin';
}

/** People let in on a ticket so far (and when). Migration 031. */
async function admissionsOf(registration) {
  const { data, error } = await supabase
    .from('event_checkins')
    .select('admitted, created_at')
    .eq('registration_id', registration.id);
  if (error) {
    if (isMissingCheckins(error)) return { available: false, admitted: 0, times: [] };
    throw error;
  }
  const rows = data || [];
  return {
    available: true,
    admitted: rows.reduce((s, r) => s + (r.admitted || 0), 0),
    times: rows.flatMap(r => Array(Math.max(1, r.admitted || 1)).fill(r.created_at)).sort()
  };
}

async function ticketView(eventId, registration, mode) {
  const m = mode || await eventMode(eventId);
  const [games, buyer, adm] = await Promise.all([
    m === 'games' ? ticketGames(registration) : Promise.resolve(null),
    buyerName(registration),
    admissionsOf(registration)
  ]);
  const tickets = quantityOf(registration);
  return {
    mode: m,
    ticket_number: ticketNumberFor(eventId, registration.linked_payment_id),
    buyer: buyer.name,
    is_guest: buyer.guest,
    games: games || [],
    plays_left: (games || []).reduce((s, g) => s + g.left, 0),
    tickets,
    admitted: adm.admitted,
    admit_left: Math.max(0, tickets - adm.admitted),
    admitted_at: adm.times,
    checkin_available: adm.available
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
    const modes = {};
    for (const id of [...new Set(rows.map(r => r.event_id))]) modes[id] = await eventMode(id);
    return successResponse(res, rows.map(r => ({
      id: r.id,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      active: r.starts_at <= now,
      mode: modes[r.event_id] || 'checkin',
      event: events.find(e => e.id === r.event_id) || { id: r.event_id, title: 'Event' }
    })), 'Your event duty appointments');
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
    if (view.mode === 'games' && !view.games.length) return errorResponse(res, 'This ticket has no games on it.', 404);
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

// Door check-in: let in `count` people on a ticket ("all" = everyone left).
router.post('/:eventId/admit', authenticate, marshalLimiter, async (req, res) => {
  try {
    const appt = await requireMarshal(req, res);
    if (!appt) return;
    const found = await findTicket(req.params.eventId, req.body?.code);
    if (found.error) return errorResponse(res, found.error, found.status);
    const reg = found.registration;
    const bought = quantityOf(reg);
    const adm = await admissionsOf(reg);
    if (!adm.available) return errorResponse(res, 'Check-in needs database migration 031 first.', 409);
    const left = Math.max(0, bought - adm.admitted);
    if (left === 0) return errorResponse(res, 'Everyone on this ticket is already in.', 409);
    const count = req.body?.count === 'all' ? left : Number(req.body?.count === undefined ? 1 : req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) return errorResponse(res, 'Admit between 1 and 50 people at a time.', 400);
    if (count > left) return errorResponse(res, `Only ${left} more ${left === 1 ? 'person' : 'people'} can come in on this ticket.`, 409);

    const { data: remaining, error } = await supabase.rpc('admit_tickets', {
      p_registration_id: reg.id,
      p_count: count,
      p_bought: bought,
      p_marshal_id: appt.id,
      p_marshal_user_id: req.userId
    });
    if (error) {
      if (/ALREADY_ADMITTED/.test(error.message || '')) return errorResponse(res, 'Someone else just admitted people on this ticket. Look it up again.', 409);
      if (/TICKET_NOT_FOUND/.test(error.message || '')) return errorResponse(res, 'Ticket not found.', 404);
      if (isMissingCheckins(error)) return errorResponse(res, 'Check-in needs database migration 031 first.', 409);
      throw error;
    }

    await auditLog({
      action: 'event_checkin',
      userId: req.userId,
      details: { event_id: req.params.eventId, registration_id: reg.id, admitted: count, left: remaining },
      ip: req.ip
    });

    const view = await ticketView(req.params.eventId, reg);
    return successResponse(res, view, `${count} ${count === 1 ? 'person' : 'people'} admitted`);
  } catch (error) {
    console.error('[marshals] admit error:', error);
    return errorResponse(res, 'Could not check that ticket in', 500, error);
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

    const [marshalsRes, itemsAll, regsRes, playsRes, checkinsRes] = await Promise.all([
      supabase.from('game_marshals').select('*').eq('event_id', eventId).order('starts_at', { ascending: false }),
      loadEventItems(eventId, { activeOnly: false }),
      supabase.from('event_registrations').select('*').eq('event_id', eventId).not('linked_payment_id', 'is', null),
      supabase.from('game_plays').select('registration_id, item_id, plays, marshal_user_id, created_at').eq('event_id', eventId),
      supabase.from('event_checkins').select('registration_id, admitted, created_at').eq('event_id', eventId)
    ]);
    for (const r of [marshalsRes, regsRes, playsRes]) if (r.error) throw r.error;
    if (checkinsRes.error && !isMissingCheckins(checkinsRes.error)) throw checkinsRes.error;
    const checkinRows = checkinsRes.error ? [] : (checkinsRes.data || []);
    const mode = itemsAll.some(i => i.is_active !== false) ? 'games' : 'checkin';

    const marshals = (marshalsRes.data || []).map(m => ({
      id: m.id, email: m.email, name: m.name, starts_at: m.starts_at, ends_at: m.ends_at,
      status: m.revoked_at ? 'removed' : (m.ends_at <= now ? 'ended' : (m.starts_at > now ? 'upcoming' : 'active'))
    }));

    const regs = (regsRes.data || []).filter(r => (r.status || 'registered') !== 'cancelled' && (mode === 'checkin' || linesFromRow(r)));
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
      let { data, error } = await supabase.from('students').select('user_id, name, first_name, last_name, email, matric_no, phone').in('user_id', userIds);
      if (error && /phone/.test(error.message || '')) ({ data, error } = await supabase.from('students').select('user_id, name, first_name, last_name, email, matric_no').in('user_id', userIds));
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
        phone: r.guest_phone || s?.phone || '',
        guest: !!r.guest_email,
        bought_at: r.registration_date || r.created_at || null,
        tickets: quantityOf(r),
        admitted: checkinRows.filter(c => c.registration_id === r.id).reduce((a, c) => a + c.admitted, 0),
        games: lines.map(l => {
          const used = plays.filter(p => p.registration_id === r.id && p.item_id === l.item_id).reduce((a, p) => a + p.plays, 0);
          const entry = (Array.isArray(r.entry_details) ? r.entry_details : []).find(e => e && e.item_id === l.item_id);
          return { name: l.name || nameOf(l.item_id), bought: l.plays, used, left: Math.max(0, l.plays - used), ...(entry ? { username: entry.username } : {}) };
        })
      };
    });

    const ticketsSold = regs.reduce((s, r) => s + quantityOf(r), 0);
    const checkedIn = checkinRows.reduce((s, c) => s + (c.admitted || 0), 0);
    return successResponse(res, {
      mode,
      marshals,
      games,
      buyers,
      checkins: { available: !checkinsRes.error, tickets_sold: ticketsSold, checked_in: checkedIn, not_yet: Math.max(0, ticketsSold - checkedIn) }
    }, 'Event duty and attendance');
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

    const { data: event, error: evErr } = await supabase.from('events').select('id, title, date, time, location, requires_payment').eq('id', eventId).maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Event not found', 404);
    const items = await loadEventItems(eventId);
    const mode = items.length ? 'games' : 'checkin';
    if (mode === 'checkin' && !event.requires_payment) {
      return errorResponse(res, 'Check-in works with paid tickets (they have ticket numbers and QR codes). This event is free.', 400);
    }

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
        sendGameMarshalInviteEmail({ student, event, startsAt: saved.starts_at, endsAt: saved.ends_at, mode }),
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
