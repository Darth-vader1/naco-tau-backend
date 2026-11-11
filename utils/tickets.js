// utils/tickets.js
// Single source of truth for event ticket quantities and seat counting.
//
// Seats are counted in TICKETS (sum of event_registrations.ticket_quantity),
// not registration rows, because one order may contain several tickets.

const { supabase } = require('../config/supabase');

// Maximum tickets a student can buy in a single order.
const MAX_TICKETS_PER_ORDER = Math.min(
  50,
  Math.max(1, parseInt(process.env.MAX_TICKETS_PER_ORDER || '10', 10) || 10)
);

/**
 * Parse a requested ticket quantity. Missing → 1.
 * Returns an integer in [1, MAX_TICKETS_PER_ORDER] or null if invalid.
 */
function parseTicketQuantity(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TICKETS_PER_ORDER) return null;
  return n;
}

/** Quantity stored on a row (defaults to 1 for rows created before migration 021). */
const quantityOf = (row) => {
  const n = Number(row?.ticket_quantity);
  return Number.isInteger(n) && n >= 1 ? n : 1;
};

/** Total price in Naira, rounded to kobo. */
const orderTotal = (unitPrice, quantity) => Math.round(Number(unitPrice) * quantity * 100) / 100;

/** Tickets already issued for an event (cancelled registrations excluded). */
async function countTicketsForEvent(eventId) {
  const { data, error } = await supabase
    .from('event_registrations')
    .select('ticket_quantity, status')
    .eq('event_id', eventId);
  if (error) throw error;
  return (data || [])
    .filter(r => (r.status || 'registered') !== 'cancelled')
    .reduce((sum, r) => sum + quantityOf(r), 0);
}

/** Seats left for `quantity` more tickets, or Infinity when the event is uncapped. */
async function seatsRemaining(event) {
  const cap = Number(event?.max_attendees);
  if (!Number.isFinite(cap) || cap <= 0) return Infinity;
  const issued = await countTicketsForEvent(event.id);
  return Math.max(0, cap - issued);
}

/** Recompute events.current_attendees (in tickets). Non-fatal. */
async function syncAttendeeCount(eventId) {
  if (!eventId) return;
  try {
    const total = await countTicketsForEvent(eventId);
    await supabase.from('events').update({ current_attendees: total }).eq('id', eventId);
  } catch (err) {
    console.warn('[tickets] could not sync current_attendees:', err?.message || err);
  }
}

module.exports = {
  MAX_TICKETS_PER_ORDER,
  parseTicketQuantity,
  quantityOf,
  orderTotal,
  countTicketsForEvent,
  seatsRemaining,
  syncAttendeeCount
};
