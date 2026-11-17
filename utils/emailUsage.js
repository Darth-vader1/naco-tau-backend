// utils/emailUsage.js
// Counts every email the backend sends, to show how close the sending Gmail
// account is to Google's limits. Google applies them over a rolling 24 hours:
//   2,000 messages, 10,000 total recipients, 3,000 external recipients,
//   3,000 unique recipients (2,000 unique external).
// Limits can be overridden with env vars (e.g. 500 on a trial account).
//
// Privacy: addresses are never stored, only a SHA-256 fingerprint of each
// (to count unique recipients), cleared after 3 days.

const crypto = require('crypto');
const { supabase } = require('../config/supabase');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = {
  messages: num(process.env.GMAIL_LIMIT_MESSAGES, 2000),
  recipients: num(process.env.GMAIL_LIMIT_RECIPIENTS, 10000),
  external_recipients: num(process.env.GMAIL_LIMIT_EXTERNAL_RECIPIENTS, 3000),
  unique_recipients: num(process.env.GMAIL_LIMIT_UNIQUE_RECIPIENTS, 3000),
  unique_external_recipients: num(process.env.GMAIL_LIMIT_UNIQUE_EXTERNAL, 2000)
};
const WARN_AT = 0.8;

const senderAddress = () => String(process.env.SMTP_USER || process.env.EMAIL_FROM || 'nacos@tau.edu.ng').toLowerCase();
/** Domains Gmail treats as internal (default: the sending account's domain). */
function internalDomains() {
  const configured = String(process.env.EMAIL_INTERNAL_DOMAINS || '')
    .split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (configured.length) return configured;
  const d = senderAddress().split('@')[1];
  return d ? [d] : [];
}
const domainOf = (a) => String(a).toLowerCase().split('@')[1] || '';
const isExternal = (a, domains) => !domains.includes(domainOf(a));
const hashOf = (a) => crypto.createHash('sha256').update(String(a).trim().toLowerCase()).digest('hex').slice(0, 32);

/** Every address a message goes to (To + Bcc), lower-cased and unique. */
function addressesOf({ to, bcc }) {
  const list = [];
  const add = (v) => {
    if (!v) return;
    (Array.isArray(v) ? v : String(v).split(',')).forEach(x => {
      const m = String(x).match(/[^\s<>,"']+@[^\s<>,"']+/);
      if (m) list.push(m[0].toLowerCase());
    });
  };
  add(to); add(bcc);
  return [...new Set(list)];
}

/** What kind of email this is, from fixed patterns (no personal data stored). */
function kindOf(subject) {
  const s = String(subject || '').toLowerCase();
  if (/ticket confirmed|game ticket/.test(s)) return 'ticket';
  if (/payment received/.test(s)) return 'payment_alert';
  if (/new hackathon team|hackathon team/.test(s)) return 'hackathon_alert';
  if (/game marshal|check-in duty/.test(s)) return 'marshal_invite';
  if (/complete your nacos|profile/.test(s)) return 'profile_reminder';
  if (/welcome|verify|verification|reset/.test(s)) return 'account';
  if (/new student|registration/.test(s)) return 'admin_alert';
  return 'broadcast_or_other';
}

/** Record one send attempt. Never throws; never blocks sending for long. */
async function recordEmailSend({ to, bcc, subject, ok = true, error = null }) {
  try {
    const addrs = addressesOf({ to, bcc });
    if (!addrs.length) return;
    const domains = internalDomains();
    const row = {
      kind: kindOf(subject),
      recipients: addrs.length,
      external_recipients: addrs.filter(a => isExternal(a, domains)).length,
      recipient_hashes: addrs.map(a => (isExternal(a, domains) ? 'x:' : 'i:') + hashOf(a)),
      ok: !!ok,
      error: error ? String(error).slice(0, 300) : null
    };
    const res = await Promise.race([
      supabase.from('email_send_log').insert([row]),
      new Promise(resolve => setTimeout(() => resolve({ error: { message: 'timeout' } }), 3000))
    ]);
    if (res && res.error && !/email_send_log|does not exist|could not find|timeout/i.test(res.error.message || '')) {
      console.warn('[email usage] could not record send:', res.error.message);
    }
  } catch (e) {
    // counting must never break email
  }
}

// Lagos calendar day (UTC+1, no daylight saving)
const lagosDay = (iso) => new Date(new Date(iso).getTime() + 3600000).toISOString().slice(0, 10);

let lastHashCleanup = 0;
async function clearOldHashes() {
  if (Date.now() - lastHashCleanup < 3600000) return;
  lastHashCleanup = Date.now();
  try {
    await supabase.from('email_send_log')
      .update({ recipient_hashes: null })
      .lt('sent_at', new Date(Date.now() - 3 * 86400000).toISOString())
      .not('recipient_hashes', 'is', null);
  } catch (_) { /* best effort */ }
}

/**
 * Usage over the rolling last 24 hours (what Gmail checks) plus a daily
 * history. Returns { available, window, limits, used, percent, status, daily }.
 */
async function getEmailUsage({ days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - Math.max(1, Math.min(90, days)) * 86400000).toISOString();
  const rows = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await supabase
      .from('email_send_log')
      .select('sent_at, recipients, external_recipients, recipient_hashes, ok')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .range(from, from + 999);
    if (error) {
      if (/email_send_log|does not exist|could not find/i.test(error.message || '') || error.code === 'PGRST205' || error.code === '42P01') {
        return { available: false, limits: LIMITS };
      }
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  clearOldHashes();

  const dayAgo = now.getTime() - 86400000;
  const last24 = rows.filter(r => new Date(r.sent_at).getTime() >= dayAgo && r.ok);
  const uniq = new Set(); const uniqExt = new Set();
  last24.forEach(r => (r.recipient_hashes || []).forEach(h => { uniq.add(h); if (h.startsWith('x:')) uniqExt.add(h); }));
  const used = {
    messages: last24.length,
    recipients: last24.reduce((s, r) => s + (r.recipients || 0), 0),
    external_recipients: last24.reduce((s, r) => s + (r.external_recipients || 0), 0),
    unique_recipients: uniq.size,
    unique_external_recipients: uniqExt.size
  };
  const percent = {};
  let worst = 0;
  for (const k of Object.keys(LIMITS)) {
    percent[k] = Math.round((used[k] / LIMITS[k]) * 1000) / 10;
    worst = Math.max(worst, used[k] / LIMITS[k]);
  }
  const status = worst >= 1 ? 'over' : worst >= WARN_AT ? 'warning' : 'ok';

  const byDay = {};
  rows.forEach(r => {
    const d = lagosDay(r.sent_at);
    const b = byDay[d] || (byDay[d] = { day: d, messages: 0, recipients: 0, failed: 0 });
    if (r.ok) { b.messages += 1; b.recipients += r.recipients || 0; } else b.failed += 1;
  });
  const daily = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  const failed24 = rows.filter(r => new Date(r.sent_at).getTime() >= dayAgo && !r.ok).length;

  return {
    available: true,
    window: 'rolling 24 hours',
    sender: senderAddress().replace(/^(.{3}).*(@.*)$/, '$1…$2'),
    internal_domains: internalDomains(),
    limits: LIMITS,
    used,
    percent,
    status,
    failed_last_24h: failed24,
    daily
  };
}

module.exports = { recordEmailSend, getEmailUsage, addressesOf, kindOf, LIMITS };
