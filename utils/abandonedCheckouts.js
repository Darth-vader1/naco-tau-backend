// utils/abandonedCheckouts.js
// Online checkouts that were started but never paid stay "pending" forever
// and clutter the admin Payments list. This marks them "abandoned" once they
// are older than a cut-off (24 hours by default).
//
// Nothing is deleted. A payment that does arrive later for an abandoned
// checkout still settles normally (webhook, return page and re-check all treat
// "abandoned" like "pending"), so this can never lose a real payment.

const { supabase } = require('../config/supabase');

const ONLINE_CHECKOUT_MARKER = '[online-checkout]';
const ABANDON_AFTER_HOURS = Math.max(1, parseInt(process.env.ABANDON_CHECKOUT_AFTER_HOURS || '24', 10) || 24);
const BATCH = 500;

/**
 * Mark stale unpaid online checkouts as abandoned.
 * Returns { marked, cutoff }.
 */
async function markAbandonedCheckouts({ olderThanHours = ABANDON_AFTER_HOURS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanHours * 3600000).toISOString();
  const { data, error } = await supabase
    .from('payments')
    .select('id, notes, submitted_at')
    .eq('status', 'pending')
    .lt('submitted_at', cutoff)
    .ilike('notes', `%${ONLINE_CHECKOUT_MARKER}%`)
    .limit(BATCH);
  if (error) throw error;
  const ids = (data || []).map(r => r.id);
  if (!ids.length) return { marked: 0, cutoff };

  const { data: updated, error: upErr } = await supabase
    .from('payments')
    .update({ status: 'abandoned' })
    .in('id', ids)
    .eq('status', 'pending') // don't touch anything that got paid meanwhile
    .select('id');
  if (upErr) throw upErr;
  return { marked: (updated || []).length, cutoff };
}

// Run at most once an hour per server instance when admins open Payments.
let lastRun = 0;
function maybeMarkAbandonedCheckouts() {
  if (Date.now() - lastRun < 3600000) return;
  lastRun = Date.now();
  markAbandonedCheckouts()
    .then(r => { if (r.marked) console.log(`[checkouts] marked ${r.marked} unpaid checkout(s) as abandoned`); })
    .catch(err => console.warn('[checkouts] abandoned-checkout cleanup failed:', err.message));
}

module.exports = { markAbandonedCheckouts, maybeMarkAbandonedCheckouts, ABANDON_AFTER_HOURS };
