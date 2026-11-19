// routes/events.js
const express = require('express');
const router = express.Router();
const { quantityOf, seatsRemaining, syncAttendeeCount } = require('../utils/tickets');
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const { triggerAutoContentBroadcast, sendEventWinnersEmail, sendEventWinnerCongratsEmail } = require('../services/email');
const { auditLog } = require('../middleware/audit');
const { isUuid, loadEventItems, parseItemsInput } = require('../utils/games');

// ============================================
// GET UPCOMING EVENTS
// ============================================
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(5);

    if (error) throw error;

    // Sync current_attendees (counted in tickets) on the events table
    {
      const syncId = (typeof id !== 'undefined' && id) ? id : (req.params && req.params.id);
      if (syncId) await syncAttendeeCount(syncId);
    }

    return successResponse(res, data || [], 'Upcoming events retrieved successfully');
  } catch (error) {
    console.error('Events fetch error:', error);
    return errorResponse(res, 'Failed to fetch events', 500, error);
  }
});

// ============================================
// GET PAST EVENTS (Enhanced with filters & pagination)
// ============================================
router.get('/past', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Extract query parameters
    const { 
      page = 1, 
      limit = 20, 
      search = '', 
      month, 
      year, 
      type 
    } = req.query;

    // Calculate pagination offset
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Start building query with count
    let query = supabase
      .from('events')
      .select('*', { count: 'exact' })
      .lt('date', today);

    // Apply search filter (title or description)
    if (search && search.trim()) {
      const searchTerm = search.trim();
      query = query.or(`title.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%`);
    }

    // Apply year and month filters
    if (year) {
      if (month) {
        // Filter by specific month and year
        const monthPadded = String(month).padStart(2, '0');
        const startDate = `${year}-${monthPadded}-01`;
        
        // Calculate last day of month
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        const endDate = `${year}-${monthPadded}-${String(lastDay).padStart(2, '0')}`;
        
        query = query.gte('date', startDate).lte('date', endDate);
      } else {
        // Filter by year only
        query = query.gte('date', `${year}-01-01`).lte('date', `${year}-12-31`);
      }
    }

    // Apply event type filter
    if (type && type.trim()) {
      query = query.eq('event_type', type.trim());
    }

    // Apply sorting and pagination
    query = query
      .order('date', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    // Execute query
    const { data, error, count } = await query;

    if (error) throw error;

    // Sync current_attendees (counted in tickets) on the events table
    {
      const syncId = (typeof id !== 'undefined' && id) ? id : (req.params && req.params.id);
      if (syncId) await syncAttendeeCount(syncId);
    }

    // Calculate pagination metadata
    const totalPages = Math.ceil(count / parseInt(limit));
    const hasMore = parseInt(page) < totalPages;

    // Return data with pagination info
    return successResponse(res, {
      events: data || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages,
        hasMore,
        showing: data?.length || 0
      }
    }, 'Past events retrieved successfully');

  } catch (error) {
    console.error('Past events fetch error:', error);
    return errorResponse(res, 'Failed to fetch past events', 500, error);
  }
});

// ============================================
// GET SINGLE EVENT
// ============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Event not found', 404);
      }
      throw error;
    }

    return successResponse(res, data, 'Event retrieved successfully');
  } catch (error) {
    console.error('Event fetch error:', error);
    return errorResponse(res, 'Failed to fetch event', 500, error);
  }
});

// Admin: every registration for an event (free and paid), with the student's
// details. Browsers can only read their own registrations (RLS), so the admin
// Attendees window needs this to see free sign-ups.
router.get('/:id/registrations', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);
    const { data: regs, error } = await supabase
      .from('event_registrations')
      .select('*')
      .eq('event_id', id)
      .order('registration_date', { ascending: false });
    if (error) throw error;
    const userIds = [...new Set((regs || []).map(r => r.user_id).filter(Boolean))];
    let students = [];
    if (userIds.length) {
      let res2 = await supabase.from('students').select('user_id, name, email, matric_no, department, phone').in('user_id', userIds);
      if (res2.error && /phone/.test(res2.error.message || '')) {
        res2 = await supabase.from('students').select('user_id, name, email, matric_no, department').in('user_id', userIds);
      }
      if (res2.error) throw res2.error;
      students = res2.data || [];
    }
    const byUser = Object.fromEntries(students.map(s => [s.user_id, s]));
    return successResponse(res, (regs || []).map(r => ({ ...r, students: byUser[r.user_id] || null })));
  } catch (error) {
    console.error('Event registrations fetch error:', error);
    return errorResponse(res, 'Failed to fetch registrations', 500, error);
  }
});

// ============================================
// GAMES (pay per play) FOR AN EVENT
// ============================================
// Public: the active games and their prices per play.
router.get('/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);
    const items = await loadEventItems(id, { activeOnly: true });
    return successResponse(res, items, 'Games retrieved successfully');
  } catch (error) {
    console.error('Event games fetch error:', error);
    return errorResponse(res, 'Failed to fetch games', 500, error);
  }
});

// Admin: replace the event's list of games.
// Body: { items: [{ id?, name, price, public_price?, max_plays?, description?, is_active? }] }
// Games left out of the list are hidden (kept, so past orders still show the
// game name). An empty list turns the event back into a normal ticketed event.
router.put('/:id/items', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);

    const parsed = parseItemsInput(req.body?.items);
    if (parsed.error) return errorResponse(res, parsed.error, 400);

    const { data: event, error: evErr } = await supabase.from('events').select('id').eq('id', id).maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Event not found', 404);

    const existing = await loadEventItems(id, { activeOnly: false });
    const existingIds = new Set(existing.map(i => i.id));
    const now = new Date().toISOString();
    const keptIds = new Set();
    let tournamentColumn = null; // false once we learn migration 032 isn't run

    for (const it of parsed.items) {
      const row = {
        name: it.name,
        description: it.description,
        price: it.price,
        public_price: it.public_price,
        max_plays: it.max_plays,
        sort_order: it.sort_order,
        is_active: it.is_active,
        updated_at: now
      };
      if (it.tournament || tournamentColumn !== false) row.tournament = !!it.tournament;
      const noTournamentCol = (error) => error && /tournament/.test(error.message || '') && /column|schema cache/i.test(error.message || '');
      if (it.id && existingIds.has(it.id)) {
        let { error } = await supabase.from('event_items').update(row).eq('id', it.id).eq('event_id', id);
        if (noTournamentCol(error)) {
          if (it.tournament) return errorResponse(res, 'Tournament games need database migration 032. Run it in Supabase, then save again.', 409);
          tournamentColumn = false; delete row.tournament;
          ({ error } = await supabase.from('event_items').update(row).eq('id', it.id).eq('event_id', id));
        }
        if (error) throw error;
        keptIds.add(it.id);
      } else {
        let { data: created, error } = await supabase
          .from('event_items')
          .insert([{ ...row, event_id: id }])
          .select('id')
          .single();
        if (noTournamentCol(error)) {
          if (it.tournament) return errorResponse(res, 'Tournament games need database migration 032. Run it in Supabase, then save again.', 409);
          tournamentColumn = false; delete row.tournament;
          ({ data: created, error } = await supabase.from('event_items').insert([{ ...row, event_id: id }]).select('id').single());
        }
        if (error) throw error;
        keptIds.add(created.id);
      }
    }

    const removed = existing.filter(i => !keptIds.has(i.id) && i.is_active).map(i => i.id);
    if (removed.length) {
      const { error } = await supabase.from('event_items').update({ is_active: false, updated_at: now }).in('id', removed);
      if (error) throw error;
    }

    // Keep the event's own price fields in step so the events list, the
    // "from ₦X" badge and the existing paid-event checks keep working:
    // payment_amount = cheapest member price, public_price = cheapest guest price.
    const active = await loadEventItems(id, { activeOnly: true });
    if (active.length) {
      const minMember = Math.min(...active.map(i => Number(i.price)));
      const guestPrices = active.map(i => Number(i.public_price)).filter(p => Number.isFinite(p) && p > 0);
      const { error } = await supabase.from('events').update({
        requires_payment: true,
        payment_amount: minMember,
        public_price: guestPrices.length ? Math.min(...guestPrices) : null,
        updated_at: now
      }).eq('id', id);
      if (error) throw error;
    }

    await auditLog({
      action: 'event_games_updated',
      userId: req.userId,
      details: { event_id: id, games: active.map(i => ({ id: i.id, name: i.name, price: i.price })) },
      ip: req.ip
    });

    return successResponse(res, active, 'Games saved');
  } catch (error) {
    console.error('Event games update error:', error);
    return errorResponse(res, 'Failed to save games', 500, error);
  }
});

// ============================================
// CREATE EVENT (Admin only)
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      time,
      location,
      image_url,
      event_type,
      requires_payment,
      payment_amount,
      max_attendees,
      send_email
    } = req.body;

    if (!title || !date) {
      return errorResponse(res, 'Title and date are required', 400);
    }

    const { data, error } = await supabase
      .from('events')
      .insert([{
        title,
        description,
        date,
        time,
        location,
        image_url,
        event_type,
        requires_payment: requires_payment || false,
        payment_amount: payment_amount || 0,
        max_attendees: max_attendees || null,
        is_active: true,
        created_by: req.userId,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    // Sync current_attendees (counted in tickets) on the events table
    {
      const syncId = (typeof id !== 'undefined' && id) ? id : (req.params && req.params.id);
      if (syncId) await syncAttendeeCount(syncId);
    }

    const shouldSendEmail = send_email !== false && send_email !== 'false';
    if (data && shouldSendEmail) {
      triggerAutoContentBroadcast('events', data);
    } else if (data && !shouldSendEmail) {
      console.log('[events/POST] Skipped email broadcast because send_email is false');
    }

    return successResponse(res, { event: data }, 'Event created successfully', 201);

  } catch (error) {
    console.error('Event creation error:', error);
    return errorResponse(res, 'Failed to create event', 500, error);
  }
});

// ============================================
// UPDATE EVENT (Admin only)
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('events')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Event not found', 404);
      }
      throw error;
    }

    return successResponse(res, { event: data }, 'Event updated successfully');

  } catch (error) {
    console.error('Event update error:', error);
    return errorResponse(res, 'Failed to update event', 500, error);
  }
});

// ============================================
// REGISTER FOR EVENT
// ============================================
router.post('/:id/register', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if event exists and is active
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (eventError || !event) {
      return errorResponse(res, 'Event not found or inactive', 404);
    }

    // Existing registrations (one row per order since migration 022)
    const { data: existingRegistrations, error: checkError } = await supabase
      .from('event_registrations')
      .select('id, linked_payment_id')
      .eq('event_id', id)
      .eq('user_id', req.userId);
    if (checkError) throw checkError;
    const myRegs = existingRegistrations || [];
    const isPaidEvent = event.requires_payment && Number(event.payment_amount) > 0;

    if (!isPaidEvent && myRegs.length) {
      return errorResponse(res, 'You are already registered for this event', 409);
    }

    // ============================================
    // PAID EVENT GATE (CRITICAL-4 fix)
    // Require verified payment if event requires one.
    // ============================================
    let verifiedPaymentId = null;
    let ticketQuantity = 1;
    if (event.requires_payment && Number(event.payment_amount) > 0) {
      const { data: verifiedPayments, error: payErr } = await supabase
        .from('payments')
        .select('id, amount, ticket_quantity')
        .eq('user_id', req.userId)
        .eq('event_id', event.id)
        .eq('payment_type', 'event_registration')
        .eq('status', 'verified')
        .order('submitted_at', { ascending: false })
        .limit(50);

      if (payErr) throw payErr;

      // Use a verified order that doesn't have its tickets yet.
      const linked = new Set(myRegs.map(r => r.linked_payment_id).filter(Boolean));
      const verifiedPayment = (verifiedPayments || []).find(p => !linked.has(p.id));

      if (!verifiedPayment && myRegs.length) {
        return errorResponse(res, 'You are already registered for this event', 409);
      }

      if (!verifiedPayment) {
        return errorResponse(
          res,
          `This is a paid event (₦${Number(event.payment_amount).toLocaleString('en-NG')}). Submit an event_registration payment proof and get it verified first, then return to register.`,
          402
        );
      }

      ticketQuantity = quantityOf(verifiedPayment);
      const requiredTotal = Number(event.payment_amount) * ticketQuantity;
      if (Number(verifiedPayment.amount) + 0.01 < requiredTotal) {
        return errorResponse(
          res,
          `Verified amount (₦${Number(verifiedPayment.amount).toLocaleString('en-NG')}) is less than the required total (₦${requiredTotal.toLocaleString('en-NG')} for ${ticketQuantity} ticket(s)).`,
          402
        );
      }

      verifiedPaymentId = verifiedPayment.id;
    }

    // ============================================
    // CAPACITY GATE (CRITICAL-5 fix)
    // Reject overflow when registrations reach event.max_attendees.
    // ============================================
    if (typeof event.max_attendees === 'number' && event.max_attendees > 0) {
      const remaining = await seatsRemaining(event);

      if (ticketQuantity > remaining) {
        return errorResponse(
          res,
          remaining > 0
            ? `Only ${remaining} ticket(s) left, but this order has ${ticketQuantity}. Contact the exco.`
            : `Event is fully booked (${event.max_attendees} / ${event.max_attendees} seats filled). Join the waitlist or contact the exco.`,
          409
        );
      }
    }

    // Register user
    const { data, error } = await supabase
      .from('event_registrations')
      .insert([{
        event_id: id,
        user_id: req.userId,
        registration_date: new Date().toISOString(),
        status: 'registered',
        linked_payment_id: verifiedPaymentId,
        ticket_quantity: ticketQuantity
      }])
      .select()
      .single();

    if (error) throw error;

    // Sync current_attendees (counted in tickets) on the events table
    {
      const syncId = (typeof id !== 'undefined' && id) ? id : (req.params && req.params.id);
      if (syncId) await syncAttendeeCount(syncId);
    }

    return successResponse(res, { registration: data }, 'Successfully registered for event');

  } catch (error) {
    console.error('Event registration error:', error);
    return errorResponse(res, 'Failed to register for event', 500, error);
  }
});

// ============================================
// EVENT & GAME NIGHT WINNERS
// ============================================

function isMissingWinnersTable(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return err.code === '42P01' || err.code === 'PGRST205' || msg.includes('event_winners');
}

async function enrichWinnersWithGames(winners) {
  if (!Array.isArray(winners) || winners.length === 0) return [];
  const itemIds = [...new Set(winners.map(w => w.item_id).filter(Boolean))];
  const gameMap = {};
  if (itemIds.length > 0) {
    const { data: items } = await supabase
      .from('event_items')
      .select('id, name')
      .in('id', itemIds);
    (items || []).forEach(it => { gameMap[it.id] = it.name; });
  }
  return winners.map(w => ({
    ...w,
    game_name: w.item_id ? (gameMap[w.item_id] || null) : null
  }));
}

// Public: Get recently announced winners across events (keyed by event_id)
router.get('/winners/recent', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('event_winners')
      .select('id, event_id, item_id, winner_name, in_game_username, placement, prize, note, announced_at')
      .not('announced_at', 'is', null)
      .order('announced_at', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      if (isMissingWinnersTable(error)) return successResponse(res, { winners: [], tableMissing: true }, 'Winners not yet configured');
      throw error;
    }

    const enriched = await enrichWinnersWithGames(data || []);
    return successResponse(res, { winners: enriched }, 'Event winners retrieved');
  } catch (error) {
    console.error('Recent winners fetch error:', error);
    return errorResponse(res, 'Failed to fetch event winners', 500, error);
  }
});

// Public / Admin: Get winners for a specific event
router.get('/:id/winners', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);

    const includeDrafts = req.query.includeDrafts === 'true' && req.headers.authorization;
    let isAdminCaller = false;
    if (includeDrafts) {
      // Verify admin if drafts requested
      try {
        const token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) {
          const { data: adminRow } = await supabase.from('admin_users').select('id').eq('user_id', user.id).maybeSingle();
          isAdminCaller = !!adminRow;
        }
      } catch (_) {}
    }

    let query = supabase
      .from('event_winners')
      .select(isAdminCaller ? '*' : 'id, event_id, item_id, winner_name, in_game_username, placement, prize, note, announced_at')
      .eq('event_id', id)
      .order('created_at', { ascending: true });

    if (!isAdminCaller) {
      query = query.not('announced_at', 'is', null);
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingWinnersTable(error)) return successResponse(res, { winners: [], tableMissing: true }, 'Winners table not yet migrated');
      throw error;
    }

    const enriched = await enrichWinnersWithGames(data || []);
    return successResponse(res, { winners: enriched }, 'Event winners retrieved');
  } catch (error) {
    console.error('Event winners fetch error:', error);
    return errorResponse(res, 'Failed to fetch event winners', 500, error);
  }
});

// Admin: Add a winner to an event
router.post('/:id/winners', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);

    const { item_id, registration_id, winner_name, in_game_username, winner_email, placement, prize, note } = req.body || {};
    if (!winner_name || !String(winner_name).trim()) {
      return errorResponse(res, 'Winner name is required', 400);
    }

    let resolvedEmail = winner_email ? String(winner_email).trim() : null;
    let resolvedGamertag = in_game_username ? String(in_game_username).trim() : null;

    if (registration_id && isUuid(registration_id)) {
      const { data: reg } = await supabase
        .from('event_registrations')
        .select('user_id, guest_email, order_items, entry_details')
        .eq('id', registration_id)
        .eq('event_id', id)
        .maybeSingle();

      if (reg) {
        if (!resolvedEmail) {
          if (reg.guest_email) {
            resolvedEmail = reg.guest_email;
          } else if (reg.user_id) {
            const { data: st } = await supabase.from('students').select('email').eq('user_id', reg.user_id).maybeSingle();
            if (st?.email) resolvedEmail = st.email;
          }
        }
        const entries = Array.isArray(reg.entry_details) ? reg.entry_details : (Array.isArray(reg.order_items) ? reg.order_items : []);
        if (!resolvedGamertag && entries.length) {
          const match = item_id ? entries.find(x => x.item_id === item_id && x.username) : entries.find(x => x.username);
          if (match?.username) resolvedGamertag = match.username;
        }
      }
    }

    const payload = {
      event_id: id,
      item_id: (item_id && isUuid(item_id)) ? item_id : null,
      registration_id: (registration_id && isUuid(registration_id)) ? registration_id : null,
      winner_name: String(winner_name).trim(),
      in_game_username: resolvedGamertag,
      winner_email: resolvedEmail,
      placement: (placement && String(placement).trim()) || '1st Place',
      prize: prize ? String(prize).trim() : null,
      note: note ? String(note).trim() : null,
      created_by: req.userId || null
    };

    const { data, error } = await supabase
      .from('event_winners')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    const [enriched] = await enrichWinnersWithGames([data]);
    await auditLog({
      action: 'event_winner_added',
      userId: req.userId,
      details: { event_id: id, winner_id: data.id, winner_name: data.winner_name, placement: data.placement },
      ip: req.ip
    });

    return successResponse(res, { winner: enriched }, 'Winner added successfully', 201);
  } catch (error) {
    console.error('Add event winner error:', error);
    return errorResponse(res, 'Failed to add event winner', 500, error);
  }
});

// Admin: Remove a winner
router.delete('/:id/winners/:winnerId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id, winnerId } = req.params;
    if (!isUuid(id) || !isUuid(winnerId)) return errorResponse(res, 'Invalid id', 400);

    const { error } = await supabase
      .from('event_winners')
      .delete()
      .eq('id', winnerId)
      .eq('event_id', id);

    if (error) throw error;

    await auditLog({
      action: 'event_winner_deleted',
      userId: req.userId,
      details: { event_id: id, winner_id: winnerId },
      ip: req.ip
    });

    return successResponse(res, null, 'Winner removed successfully');
  } catch (error) {
    console.error('Delete event winner error:', error);
    return errorResponse(res, 'Failed to remove winner', 500, error);
  }
});

// Admin: Publish / Announce winners & optionally email winners / participants / students
router.post('/:id/winners/announce', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 'Invalid event id', 400);

    const { notify_winners = true, notify_scope = 'participants' } = req.body || {};

    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('id, title, date')
      .eq('id', id)
      .maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Event not found', 404);

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from('event_winners')
      .update({ announced_at: now })
      .eq('event_id', id)
      .select();

    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      return errorResponse(res, 'Add at least one winner before announcing.', 400);
    }

    const winners = await enrichWinnersWithGames(updated);
    let congratsSent = 0;
    let broadcastCount = 0;

    if (notify_winners) {
      const results = await Promise.allSettled(
        winners.filter(w => w.winner_email).map(w => sendEventWinnerCongratsEmail({ event, winner: w }))
      );
      congratsSent = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    }

    if (notify_scope === 'all_students') {
      const bRes = await sendEventWinnersEmail({ event, winners, broadcastAll: true });
      broadcastCount = bRes?.totalSent || bRes?.sentCount || 0;
    } else if (notify_scope === 'participants') {
      const { data: regs } = await supabase
        .from('event_registrations')
        .select('user_id, guest_email')
        .eq('event_id', id);

      const emails = new Set();
      const userIds = [];
      (regs || []).forEach(r => {
        if (r.guest_email) emails.add(String(r.guest_email).trim().toLowerCase());
        if (r.user_id) userIds.push(r.user_id);
      });
      if (userIds.length > 0) {
        const { data: studs } = await supabase
          .from('students')
          .select('email')
          .in('user_id', [...new Set(userIds)]);
        (studs || []).forEach(s => { if (s.email) emails.add(String(s.email).trim().toLowerCase()); });
      }
      if (emails.size > 0) {
        const bRes = await sendEventWinnersEmail({ event, winners, recipients: [...emails], broadcastAll: false });
        broadcastCount = bRes?.sentCount || 0;
      }
    }

    await auditLog({
      action: 'event_winners_announced',
      userId: req.userId,
      details: { event_id: id, winner_count: winners.length, congratsSent, notify_scope, broadcastCount },
      ip: req.ip
    });

    return successResponse(res, {
      winners,
      congratsSent,
      broadcastCount
    }, 'Winners announced successfully!');
  } catch (error) {
    console.error('Announce winners error:', error);
    return errorResponse(res, 'Failed to announce winners', 500, error);
  }
});

module.exports = router;
