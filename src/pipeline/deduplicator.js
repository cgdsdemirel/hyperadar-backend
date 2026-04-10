'use strict';

/**
 * Deduplicate an array of raw trend objects by normalized title.
 *
 * Normalization: lowercase → strip non-alphanumeric chars → collapse whitespace → trim.
 * Strategy: exact match only (no fuzzy / Levenshtein) — good enough for MVP.
 * On collision the FIRST occurrence wins (preserve insertion order).
 *
 * @param {Array<{ title: string, [key: string]: any }>} trends
 * @returns {Array<{ title: string, [key: string]: any }>} Deduplicated array
 */
function deduplicate(trends) {
  const seen = new Set();

  return trends.filter((trend) => {
    const normalized = normalize(trend.title);
    if (!normalized) return false; // drop items with empty titles
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Normalize a title string for comparison purposes.
 * @param {string} title
 * @returns {string}
 */
function normalize(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // remove special chars
    .replace(/\s+/g, ' ')        // collapse whitespace
    .trim();
}

module.exports = { deduplicate, normalize };
