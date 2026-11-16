// prizeFormat.js
// Formats naira amounts inside free-text prize descriptions, e.g.
//   "300000"                                  -> "₦300,000"
//   "N300,000 (1st: 150k, 2nd: 100k)"         -> "₦300,000 (1st: ₦150,000, 2nd: ₦100,000)"
//   "NGN 1.5m plus internships"               -> "₦1,500,000 plus internships"
// Leaves alone: ordinals (1st, 2nd), small counts ("Top 3"), years ("2026"),
// percentages, and amounts in other currencies ($500, 500 USD).
//
// The same file is used by the backend (require) and the frontend (<script>,
// exposed as window.NacosFormat.prizePool), so emails and pages always agree.
(function (root) {
  'use strict';

  // [currency marker] amount [multiplier] [naira word]
  // The optional space belongs to the currency marker only, so text before a
  // bare amount keeps its spacing ("share 500k" -> "share ₦500,000").
  const AMOUNT_RE = /((?:₦|\bNGN\b|\bN(?=\s?\d)|#(?=\d))\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?(?:k|m|bn)\b|\s?(?:thousand|million|billion)\b)?(\s?(?:naira|ngn)\b)?/gi;

  const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

  function naira(value) {
    return '₦' + value.toLocaleString('en-NG', { maximumFractionDigits: 2 });
  }

  /**
   * @param {string|number|null} prize  Free text or a number.
   * @param {object} [opts]
   * @param {string} [opts.fallback=''] Returned when there is no prize text.
   */
  function formatPrizePool(prize, opts) {
    const fallback = (opts && typeof opts.fallback === 'string') ? opts.fallback : '';
    if (prize === null || prize === undefined) return fallback;
    const text = String(prize).trim();
    if (!text) return fallback;

    return text.replace(AMOUNT_RE, (match, currencyWithSpace, num, multiplier, nairaWord, offset, whole) => {
      const currency = currencyWithSpace ? currencyWithSpace.trim() : '';
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);

      // Another currency, an HTML entity (&#8358;), or the middle of a word/number
      if (/[$£€]\s?$/.test(before)) return match;
      if (currency === '#' && /&$/.test(before)) return match;
      if (!currency && /[A-Za-z0-9_.,]$/.test(before)) return match;
      // Ordinals (1st), percentages, other currencies after the number
      if (/^(st|nd|rd|th)\b/i.test(after)) return match;
      if (/^\s?%/.test(after)) return match;
      if (/^\s?(usd|dollars?|gbp|pounds?|eur|euros?)\b/i.test(after)) return match;

      let value = Number(num.replace(/,/g, ''));
      if (!Number.isFinite(value)) return match;
      const mult = (multiplier || '').trim().toLowerCase();
      if (mult) value *= MULTIPLIERS[mult] || 1;

      const marked = !!currency || !!nairaWord || !!mult || num.includes(',');
      const wholeFieldIsTheNumber = whole.trim() === match.trim();

      if (currency === '#' && value < 100) return match;                         // "#1 team"
      if (!marked && /^(19|20)\d{2}$/.test(num) && !wholeFieldIsTheNumber) return match; // a year
      if (!marked && !wholeFieldIsTheNumber && value < 1000) return match;        // "Top 3"

      return naira(value);
    });
  }

  const api = { prizePool: formatPrizePool, formatPrizePool };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.NacosFormat = Object.assign(root.NacosFormat || {}, api);
  }
})(typeof window !== 'undefined' ? window : this);
