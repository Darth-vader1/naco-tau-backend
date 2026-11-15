// utils/games.js
// Games inside an event (event_items), priced PER PLAY.
//
// An event "has games" when it has at least one active event_item. Buying
// works exactly like buying tickets: the buyer picks one game and a quantity
// (= number of plays), and the order total is game price x plays (+ fees).

const { supabase } = require('../config/supabase');
const { quantityOf } = require('./tickets');

const MAX_GAMES_PER_EVENT = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Migration 024 not run yet. Postgres says 42P01; Supabase's REST layer says
// PGRST205 ("Could not find the table ... in the schema cache").
const isMissingTable = (error) => !!error && (
  error.code === '42P01' || error.code === 'PGRST205' ||
  (/event_items/.test(error.message || '') && /does not exist|could not find/i.test(error.message || ''))
);

/** Games for an event, in display order. */
async function loadEventItems(eventId, { activeOnly = true } = {}) {
  let q = supabase
    .from('event_items')
    .select('*')
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) {
    // Table not created yet (migration 024 not run): behave as "no games".
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

/** One game by id (any status). */
async function loadEventItem(itemId) {
  if (!isUuid(itemId)) return null;
  const { data, error } = await supabase.from('event_items').select('*').eq('id', itemId).maybeSingle();
  if (error) { if (isMissingTable(error)) return null; throw error; }
  return data || null;
}

/** Plays left for a game with its own cap, or Infinity when uncapped. */
async function playsRemainingForItem(item) {
  const cap = Number(item?.max_plays);
  if (!Number.isFinite(cap) || cap <= 0) return Infinity;
  const { data, error } = await supabase
    .from('event_registrations')
    .select('ticket_quantity, status')
    .eq('event_item_id', item.id);
  if (error) throw error;
  const used = (data || [])
    .filter(r => (r.status || 'registered') !== 'cancelled')
    .reduce((sum, r) => sum + quantityOf(r), 0);
  return Math.max(0, cap - used);
}

/** "Game Night: FIFA" style title used on tickets, receipts and emails. */
const titleWithItem = (event, item) =>
  item && item.name ? `${event?.title || 'Event'}: ${item.name}` : (event?.title || 'Event');

const playsLabel = (n) => `${n} play${n > 1 ? 's' : ''}`;

/**
 * Validate the admin's list of games for an event.
 * Returns { items } (normalised) or { error }.
 */
function parseItemsInput(raw) {
  if (!Array.isArray(raw)) return { error: 'items must be a list of games.' };
  if (raw.length > MAX_GAMES_PER_EVENT) return { error: `An event can have at most ${MAX_GAMES_PER_EVENT} games.` };

  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] || {};
    const name = typeof it.name === 'string' ? it.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 80) return { error: `Game ${i + 1}: name is required (max 80 characters).` };

    const price = Number(it.price);
    if (!Number.isFinite(price) || price <= 0 || price > 10000000) return { error: `${name}: price per play must be more than ₦0.` };

    let publicPrice = null;
    if (it.public_price !== undefined && it.public_price !== null && it.public_price !== '') {
      publicPrice = Number(it.public_price);
      if (!Number.isFinite(publicPrice) || publicPrice <= 0 || publicPrice > 10000000) return { error: `${name}: guest price must be more than ₦0, or left empty.` };
    }

    let maxPlays = null;
    if (it.max_plays !== undefined && it.max_plays !== null && it.max_plays !== '') {
      maxPlays = Number(it.max_plays);
      if (!Number.isInteger(maxPlays) || maxPlays <= 0) return { error: `${name}: play limit must be a whole number, or left empty.` };
    }

    const description = typeof it.description === 'string' ? it.description.trim().slice(0, 300) : null;

    items.push({
      id: isUuid(it.id) ? it.id : null,
      name,
      description: description || null,
      price: Math.round(price * 100) / 100,
      public_price: publicPrice === null ? null : Math.round(publicPrice * 100) / 100,
      max_plays: maxPlays,
      sort_order: i,
      is_active: it.is_active !== false
    });
  }
  return { items };
}

module.exports = {
  MAX_GAMES_PER_EVENT,
  isUuid,
  loadEventItems,
  loadEventItem,
  playsRemainingForItem,
  titleWithItem,
  playsLabel,
  parseItemsInput
};
