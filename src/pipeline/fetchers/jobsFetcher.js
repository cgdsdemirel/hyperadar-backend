'use strict';

/**
 * Trending Jobs & Roles fetcher.
 *
 * Flow:
 *   1. Pull job listings from Indeed + TechCrunch Jobs RSS feeds
 *   2. Extract raw job titles, normalize & group by role, count frequency
 *   3. Send the top-N role frequency table to Claude in one aggregated call
 *   4. Claude returns 5 roles with the strongest growth signals
 *   5. Return normalised raw items — the standard enricher loop in pipeline.js
 *      then produces bilingual (EN + TR) enriched records for the DB
 */

const Parser    = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../../utils/logger');

const parser = new Parser({ timeout: 15_000 });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Feed list ────────────────────────────────────────────────────────────────

const FEEDS = [
  'https://www.indeed.com/rss?q=&l=&sort=date',
  'https://feeds.feedburner.com/JobsOnTechCrunch',
  'https://techcrunch.com/jobs/feed/',            // fallback if FeedBurner redirects
];

const ITEMS_PER_FEED = 50;   // gather many listings for a meaningful frequency count
const TOP_ROLES      = 20;   // send the top-N normalised roles to the LLM

// ─── Title normalisation ──────────────────────────────────────────────────────

// Seniority / modifier words that don't define the role itself
const STRIP_PREFIX = /^(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|mid[\s-]?level|entry[\s-]?level|executive|chief|head\s+of|director\s+of|vp\s+of|vice\s+president\s+of)\s+/i;
// Roman numerals, arabic numerals, and common location tags at the end
const STRIP_SUFFIX = /[\s,]+(i{1,3}|iv|v|\d+|\(remote\)|\(hybrid\)|\(contract\)|remote|hybrid|contract)$/i;

/**
 * Strip seniority modifiers from a job title so that
 * "Senior Software Engineer" and "Junior Software Engineer" both
 * map to the same "software engineer" bucket.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeRole(raw) {
  return raw
    .toLowerCase()
    .replace(STRIP_PREFIX, '')
    .replace(STRIP_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Feed collection ──────────────────────────────────────────────────────────

/**
 * Fetch job titles from all configured feeds.
 * Failures on individual feeds are logged and skipped.
 *
 * @returns {Promise<string[]>} Raw job title strings (un-normalised)
 */
async function fetchJobTitles() {
  const titles = [];

  for (const url of FEEDS) {
    try {
      const parsed = await parser.parseURL(url);
      const items  = parsed.items || [];

      for (const item of items.slice(0, ITEMS_PER_FEED)) {
        const title = (item.title || '').trim();
        if (title) titles.push(title);
      }

      logger.info(`[JobsFetcher] "${url}" — ${items.length} item(s)`);
    } catch (err) {
      // Non-fatal: Indeed's RSS occasionally rate-limits; TechCrunch is the
      // reliable fallback.
      logger.warn(`[JobsFetcher] Feed "${url}" failed — ${err.message}`);
    }
  }

  return titles;
}

// ─── Role grouping ────────────────────────────────────────────────────────────

/**
 * Group raw job titles by normalised role name and return the top N
 * roles sorted by listing count descending.
 *
 * @param {string[]} titles
 * @param {number}   topN
 * @returns {Array<{ role: string, count: number }>}
 */
function groupByRole(titles, topN) {
  const freq = new Map();

  for (const title of titles) {
    const key = normalizeRole(title);
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([role, count]) => ({ role, count }));
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

/**
 * Ask Claude to identify 5 roles with the strongest demand growth from
 * the frequency table.
 *
 * One automatic retry on JSON-parse failure; returns [] so the pipeline
 * can skip gracefully rather than crashing the whole run.
 *
 * @param {Array<{ role: string, count: number }>} roleFreqs
 * @returns {Promise<Array<{ title: string, description: string, score: number }>>}
 */
async function extractTopRoles(roleFreqs) {
  const lines = roleFreqs
    .map((r, i) => `${i + 1}. ${r.role} (${r.count} listing${r.count !== 1 ? 's' : ''})`)
    .join('\n');

  const prompt =
    'From these job listings, identify 5 roles showing the strongest growth signals. ' +
    'For each return: title (role name), description (why demand is rising, 2 sentences), ' +
    'score (1-100).\n\n' +
    `Job role frequency:\n${lines}\n\n` +
    'Return ONLY a valid JSON array — no explanation, no markdown, no code blocks:\n' +
    '[{"title":"...","description":"...","score":85},...]';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const message = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }],
      });

      const raw     = message.content?.[0]?.text?.trim() || '';
      const cleaned = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i,     '')
        .replace(/```\s*$/i,     '')
        .trim();

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) throw new Error('LLM did not return a JSON array');

      return parsed.slice(0, 5);
    } catch (err) {
      if (attempt === 1) {
        logger.warn(`[JobsFetcher] LLM attempt 1 failed — ${err.message}, retrying…`);
      } else {
        logger.error(`[JobsFetcher] Both LLM attempts failed — ${err.message}`, err);
      }
    }
  }

  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch trending job roles.
 *
 * Returns [] for every region except 'Global' — job signal aggregation
 * is cross-source and global; per-region runs would produce identical data.
 *
 * Returned shape matches all other fetchers:
 *   { title, description, source, region, lang }
 * The pipeline tags `category` and the enrich() loop handles bilingual output.
 *
 * @param {string} region
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchJobTrends(region) {
  if (region !== 'Global') return [];

  const titles = await fetchJobTitles();

  if (titles.length === 0) {
    logger.warn('[JobsFetcher] No job titles collected — skipping LLM call');
    return [];
  }

  const roleFreqs = groupByRole(titles, TOP_ROLES);

  if (roleFreqs.length === 0) {
    logger.warn('[JobsFetcher] Role grouping produced no results');
    return [];
  }

  logger.info(
    `[JobsFetcher] ${titles.length} titles → ${roleFreqs.length} unique roles, calling LLM…`
  );

  const roles = await extractTopRoles(roleFreqs);

  if (roles.length === 0) {
    logger.warn('[JobsFetcher] LLM returned no roles');
    return [];
  }

  logger.info(`[JobsFetcher] Extracted ${roles.length} trending role(s)`);

  return roles.map((r) => ({
    title:       String(r.title       || '').slice(0, 255),
    description: String(r.description || ''),
    source:      'jobs_rss',
    region:      'Global',
    lang:        'en',
  }));
}

module.exports = { fetchJobTrends };
