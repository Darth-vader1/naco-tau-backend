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
  // Plays come from single-game orders (event_item_id) and multi-game
  // orders (order_items lines), so read the event's game orders and count.
  let res = await supabase
    .from('event_registrations')
    .select('ticket_quantity, status, event_item_id, order_items')
    .eq('event_id', item.event_id);
  if (res.error && isMissingColumn(res.error, 'order_items')) {
    res = await supabase
      .from('event_registrations')
      .select('ticket_quantity, status, event_item_id')
      .eq('event_item_id', item.id);
  }
  if (res.error) throw res.error;
  const used = (res.data || [])
    .filter(r => (r.status || 'registered') !== 'cancelled')
    .reduce((sum, r) => sum + playsOfItemIn(r, item.id), 0);
  return Math.max(0, cap - used);
}

const isMissingColumn = (error, col) => !!error && (
  error.code === '42703' || error.code === 'PGRST204' ||
  new RegExp(col).test(error.message || '') && /does not exist|could not find/i.test(error.message || '')
);

/** How many plays of one game a registration or payment row holds. */
function playsOfItemIn(row, itemId) {
  if (Array.isArray(row?.order_items) && row.order_items.length) {
    return row.order_items.filter(l => l && l.item_id === itemId).reduce((s, l) => s + (parseInt(l.plays, 10) || 0), 0);
  }
  return row?.event_item_id === itemId ? quantityOf(row) : 0;
}

// ---------------------------------------------------------------------------
// Orders with several games: lines = [{ item_id, plays }]
// ---------------------------------------------------------------------------
const MAX_PLAYS_PER_GAME = Math.max(1, parseInt(process.env.MAX_TICKETS_PER_ORDER || '10', 10) || 10);
const MAX_PLAYS_PER_ORDER = Math.max(MAX_PLAYS_PER_GAME, parseInt(process.env.MAX_PLAYS_PER_ORDER || '50', 10) || 50);

/**
 * Game lines the buyer asked for. Accepts `items: [{ item_id, plays }]`, or
 * the older single-game `item_id` + quantity. Returns { lines } (null when
 * no game was picked) or { error }.
 */
function parseGameLines(body = {}, quantity = null) {
  if (Array.isArray(body.items) && body.items.length) {
    if (body.items.length > MAX_GAMES_PER_EVENT) return { error: `You can pick at most ${MAX_GAMES_PER_EVENT} games per order.` };
    const merged = new Map();
    for (const raw of body.items) {
      const id = raw && raw.item_id;
      const plays = Number(raw && raw.plays);
      if (!isUuid(id)) return { error: 'One of the games picked is not valid.' };
      if (!Number.isInteger(plays) || plays < 1) return { error: 'Each game needs at least 1 play.' };
      merged.set(id, (merged.get(id) || 0) + plays);
    }
    const lines = [...merged].map(([item_id, plays]) => ({ item_id, plays }));
    if (lines.some(l => l.plays > MAX_PLAYS_PER_GAME)) return { error: `You can buy up to ${MAX_PLAYS_PER_GAME} plays of each game per order.` };
    const total = lines.reduce((s, l) => s + l.plays, 0);
    if (total > MAX_PLAYS_PER_ORDER) return { error: `You can buy up to ${MAX_PLAYS_PER_ORDER} plays per order.` };
    return { lines };
  }
  if (body.item_id) {
    if (!isUuid(body.item_id)) return { error: 'That game is not part of this event.' };
    const plays = Number(quantity);
    if (!Number.isInteger(plays) || plays < 1 || plays > MAX_PLAYS_PER_GAME) return { error: `You can buy between 1 and ${MAX_PLAYS_PER_GAME} plays per game.` };
    return { lines: [{ item_id: body.item_id, plays }] };
  }
  return { lines: null };
}

/** Game lines recorded on a payment (or registration) row, or null. */
function linesFromRow(row) {
  if (!row) return null;
  if (Array.isArray(row.order_items) && row.order_items.length) {
    return row.order_items.map(l => ({ item_id: l.item_id, plays: parseInt(l.plays, 10) || 0, name: l.name, unit_price: l.unit_price }));
  }
  if (row.event_item_id) return [{ item_id: row.event_item_id, plays: quantityOf(row) }];
  return null;
}

/**
 * Price game lines against the event's games. When settling a paid order a
 * game hidden since checkout still counts. Returns
 * { lines: [{ item_id, name, plays, unit_price }], quantity, subtotal } or { error, status }.
 */
async function priceGameLines(event, lines, { guest = false, settling = false, activeItems = null } = {}) {
  const items = activeItems || await loadEventItems(event.id);
  const priced = [];
  for (const line of lines) {
    const item = items.find(i => i.id === line.item_id) || (settling ? await loadEventItem(line.item_id) : null);
    if (!item || item.event_id !== event.id) return { error: 'That game is not part of this event.', status: 400 };
    let price;
    if (guest) {
      price = Number(item.public_price);
      if (!event.open_to_public || !Number.isFinite(price) || price <= 0) {
        return { error: `${item.name} is for NACOS members only. Please sign in to play.`, status: 403 };
      }
    } else {
      price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0) return { error: `${item.name} has no price set.`, status: 400 };
    }
    priced.push({ item_id: item.id, name: item.name, plays: line.plays, unit_price: Math.round(price * 100) / 100, _item: item });
  }
  const quantity = priced.reduce((s, l) => s + l.plays, 0);
  const subtotal = Math.round(priced.reduce((s, l) => s + l.unit_price * l.plays, 0) * 100) / 100;
  return { lines: priced, quantity, subtotal };
}

/** Same shape as fees.orderBreakdown, for a game order. */
function gameBreakdown(priced, feePerPlay) {
  const fee = Math.round(Number(feePerPlay || 0) * 100) / 100;
  const service = Math.round(fee * priced.quantity * 100) / 100;
  return {
    unit_price: priced.quantity ? Math.round((priced.subtotal / priced.quantity) * 100) / 100 : 0,
    quantity: priced.quantity,
    service_fee_per_ticket: fee,
    subtotal_amount: priced.subtotal,
    service_fee: service,
    total_amount: Math.round((priced.subtotal + service) * 100) / 100
  };
}

/** Columns that record the games on a payment/registration row. One game
 *  keeps the original single-game column; several use order_items. */
function gameColumns(lines) {
  if (!lines || !lines.length) return {};
  if (lines.length === 1) return { event_item_id: lines[0].item_id };
  return { event_item_id: null, order_items: lines.map(l => ({ item_id: l.item_id, name: l.name, plays: l.plays, unit_price: l.unit_price })) };
}

/** Game lines with names for a row (loads names for single-game rows). */
async function describeGameOrder(row) {
  const lines = linesFromRow(row);
  if (!lines) return null;
  for (const l of lines) {
    if (!l.name) { const it = await loadEventItem(l.item_id); l.name = it ? it.name : 'Game'; }
  }
  // One-game rows don't store a unit price; the order's subtotal gives it.
  const sub = Number(row.subtotal_amount ?? row.amount);
  if (lines.length === 1 && lines[0].unit_price == null && lines[0].plays > 0 && Number.isFinite(sub) && sub > 0) {
    lines[0].unit_price = Math.round((sub / lines[0].plays) * 100) / 100;
  }
  return lines;
}

/** "FIFA × 2, Ludo × 1" (one game: just its name). */
const gamesSummary = (lines) => !lines || !lines.length ? ''
  : lines.length === 1 ? lines[0].name
  : lines.map(l => `${l.name} × ${l.plays}`).join(', ');

/** "Game Night: FIFA" / "Game Night: FIFA × 2, Ludo × 1" for tickets, receipts and emails. */
const titleWithGames = (event, lines) =>
  lines && lines.length ? `${event?.title || 'Event'}: ${gamesSummary(lines)}` : (event?.title || 'Event');

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
      tournament: it.tournament === true || it.tournament === 'true',
      sort_order: i,
      is_active: it.is_active !== false
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// Tournaments (e.g. eFootball Mobile): 1 entry per person + player username
// ---------------------------------------------------------------------------
const PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;
const USERNAME_MAX = 40;
const PENDING_HOLD_MINUTES = 5;

/** Phone number the buyer typed at checkout (required). */
function parseBuyerPhone(raw) {
  const phone = typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, '').trim() : '';
  if (!phone) return { error: 'Please enter your phone number.' };
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7) return { error: 'Please enter a valid phone number.' };
  return { phone };
}

const isTournamentLine = (l) => !!(l && l._item && l._item.tournament);

/**
 * Player usernames for the tournament games in an order.
 * body.usernames = { [item_id]: "username" }. Returns { entries } (null when
 * the order has no tournament game) or { error }.
 */
function parseEntryUsernames(body = {}, game) {
  const lines = (game && game.lines || []).filter(isTournamentLine);
  if (!lines.length) return { entries: null };
  const given = body && typeof body.usernames === 'object' && body.usernames ? body.usernames : {};
  const entries = [];
  for (const l of lines) {
    const raw = typeof given[l.item_id] === 'string' ? given[l.item_id] : '';
    const username = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ');
    if (username.length < 2) return { error: `Please enter your ${l.name} player username.` };
    if (username.length > USERNAME_MAX) return { error: `${l.name} username is too long (max ${USERNAME_MAX} characters).` };
    entries.push({ item_id: l.item_id, name: l.name, username });
  }
  return { entries };
}

/**
 * Refuse a tournament entry that breaks "1 per person": more than 1 entry in
 * the order, an entry the buyer already holds, or a checkout for it still
 * open (last 30 minutes). Buyer = { userId } or { guestEmail }.
 */
async function tournamentError(game, { userId = null, guestEmail = null, resolvePending = null } = {}) {
  const lines = (game && game.lines || []).filter(isTournamentLine);
  if (!lines.length) return null;
  for (const l of lines) {
    if (l.plays > 1) return `${l.name} is a tournament: 1 entry per person.`;
  }
  if (!userId && !guestEmail) return null;
  const eventId = lines[0]._item.event_id;
  const byBuyer = (q) => userId ? q.eq('user_id', userId) : q.ilike('guest_email', guestEmail);

  let regs = await byBuyer(supabase.from('event_registrations')
    .select('status, ticket_quantity, event_item_id, order_items').eq('event_id', eventId));
  if (regs.error && isMissingColumn(regs.error, 'order_items')) {
    regs = await byBuyer(supabase.from('event_registrations').select('status, ticket_quantity, event_item_id').eq('event_id', eventId));
  }
  if (regs.error) throw regs.error;
  const held = (regs.data || []).filter(r => (r.status || 'registered') !== 'cancelled');

  const since = new Date(Date.now() - PENDING_HOLD_MINUTES * 60 * 1000).toISOString();
  let pend = await byBuyer(supabase.from('payments')
    .select('id, transaction_id, amount, user_id, guest_email, notes, status, ticket_quantity, event_item_id, order_items, submitted_at')
    .eq('event_id', eventId).eq('status', 'pending').gte('submitted_at', since));
  if (pend.error && isMissingColumn(pend.error, 'order_items')) {
    pend = await byBuyer(supabase.from('payments').select('id, transaction_id, amount, user_id, guest_email, notes, status, ticket_quantity, event_item_id, submitted_at')
      .eq('event_id', eventId).eq('status', 'pending').gte('submitted_at', since));
  }
  const pending = pend.error ? [] : (pend.data || []);

  for (const l of lines) {
    if (held.some(r => playsOfItemIn(r, l.item_id) > 0)) return `You already have an entry for ${l.name}. It's 1 entry per person.`;
    const matchingPending = pending.filter(p => playsOfItemIn(p, l.item_id) > 0);
    if (matchingPending.length) {
      if (typeof resolvePending === "function") {
        let blocked = false;
        for (const p of matchingPending) {
          const outcome = await resolvePending(p);
          if (outcome === "paid") {
            return `You already paid for ${l.name}! Your ticket has been confirmed and emailed to you — check "My payments & tickets" (or "Find my guest ticket").`;
          }
          if (outcome !== "abandoned") {
            blocked = true;
          }
        }
        if (!blocked) continue;
      }
      return `You already started a checkout for ${l.name}. Finish that payment, or try again in ${PENDING_HOLD_MINUTES} minutes.`;
    }
  }
  return null;
}

/** Which games of an event are fully booked: [{ item_id, full }]. No counts. */
async function gamesAvailability(eventId) {
  const items = await loadEventItems(eventId);
  const out = [];
  for (const it of items) {
    const left = await playsRemainingForItem(it);
    out.push({ item_id: it.id, full: left <= 0 });
  }
  return out;
}

module.exports = {
  parseBuyerPhone,
  parseEntryUsernames,
  tournamentError,
  gamesAvailability,
  isTournamentLine,
  MAX_GAMES_PER_EVENT,
  isUuid,
  loadEventItems,
  loadEventItem,
  playsRemainingForItem,
  titleWithItem,
  titleWithGames,
  gamesSummary,
  playsLabel,
  parseItemsInput,
  parseGameLines,
  linesFromRow,
  priceGameLines,
  gameBreakdown,
  gameColumns,
  describeGameOrder,
  playsOfItemIn,
  isMissingColumn,
  MAX_PLAYS_PER_GAME,
  MAX_PLAYS_PER_ORDER
};
