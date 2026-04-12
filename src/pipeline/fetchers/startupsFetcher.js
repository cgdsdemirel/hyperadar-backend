'use strict';

/**
 * Rising Startups fetcher.
 *
 * Flow:
 *   1. Pull startup news from Crunchbase + AngelList / TechCrunch Startups feeds
 *   2. Extract startup name, funding info, and sector from each item
 *   3. Send up to MAX_ITEMS structured summaries to Claude in one call
 *   4. Claude returns 5 startups with the most momentum
 *   5. Return normalised raw items — the standard enricher loop in pipeline.js
 *      then produces bilingual (EN + TR) enriched records for the DB
 *
 * Note on monetization_hint: the LLM is asked to return funding amount/stage
 * when available.  The enricher overwrites monetization_hint with its own
 * output, so this value is surfaced via Claude's enrichment pass, not from
 * the raw fetcher item.  The prompt ensures Claude has the funding context
 * it needs to produce a useful hint.
 */

const Parser    = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../../utils/logger');

const parser = new Parser({ timeout: 15_000 });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Feed list ────────────────────────────────────────────────────────────────

const FEEDS = [
  'https://news.crunchbase.com/feed/',
  'https://angel.co/blog/feed',
  'https://techcrunch.com/startups/feed/',   // fallback if AngelList feed is unavailable
];

const ITEMS_PER_FEED = 20;   // enough items for a strong signal per feed
const MAX_ITEMS      = 40;   // cap sent to the LLM to control token usage

// ─── Feed collection ──────────────────────────────────────────────────────────

/**
 * Fetch and parse startup news items from all configured feeds.
 * Each item is reduced to a compact summary for the LLM prompt:
 *   "Startup Name — short description [funding / sector if present]"
 *
 * Failures on individual feeds are logged and skipped.
 *
 * @returns {Promise<string[]>} Up to MAX_ITEMS compact summary strings
 */
async function fetchStartupItems() {
  const items = [];

  for (const url of FEEDS) {
    try {
      const parsed = await parser.parseURL(url);
      const feed   = parsed.items || [];

      for (const item of feed.slice(0, ITEMS_PER_FEED)) {
        const title   = (item.title         || '').trim();
        const snippet = (item.contentSnippet || item.summary || '').trim().slice(0, 300);

        if (!title) continue;

        // Keep compact: title + first sentence of snippet captures
        // most funding/stage/sector signals without blowing token budget.
        const summary = snippet
          ? `${title} — ${snippet.split(/[.!?]/)[0].trim()}`
          : title;

        items.push(summary);
      }

      logger.info(`[StartupsFetcher] "${url}" — ${feed.length} item(s)`);
    } catch (err) {
      // Non-fatal: Crunchbase / AngelList feeds are sometimes rate-limited
      // or behind auth walls; TechCrunch Startups is the reliable fallback.
      logger.warn(`[StartupsFetcher] Feed "${url}" failed — ${err.message}`);
    }
  }

  return items.slice(0, MAX_ITEMS);
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

/**
 * Ask Claude to identify 5 rising startups from the collected news summaries.
 *
 * The prompt asks for monetization_hint (funding amount / stage) so that
 * the enricher can produce a more useful hint when it re-processes the item.
 *
 * One automatic retry on JSON-parse failure; returns [] so the pipeline
 * combo loop skips gracefully rather than crashing the whole run.
 *
 * @param {string[]} summaries
 * @returns {Promise<Array<{ title: string, description: string, score: number, monetization_hint: string }>>}
 */
async function extractRisingStartups(summaries) {
  const numbered = summaries.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt =
    'From these startup news items, identify 5 startups gaining the most momentum. ' +
    'For each return: title (startup name), description (what they do and why they\'re rising, 2 sentences), ' +
    'score (1-100 based on buzz), monetization_hint (funding amount or stage if available).\n\n' +
    `News items:\n${numbered}\n\n` +
    'Return ONLY a valid JSON array — no explanation, no markdown, no code blocks:\n' +
    '[{"title":"...","description":"...","score":85,"monetization_hint":"..."},...]';

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
        logger.warn(`[StartupsFetcher] LLM attempt 1 failed — ${err.message}, retrying…`);
      } else {
        logger.error(`[StartupsFetcher] Both LLM attempts failed — ${err.message}`, err);
      }
    }
  }

  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch rising startup trends.
 *
 * Returns [] for every region except 'Global' — startup momentum signals
 * are drawn from global news sources; per-region runs would duplicate work.
 *
 * Returned shape matches all other fetchers:
 *   { title, description, source, region, lang }
 * The pipeline tags `category`; the enrich() loop writes EN + TR rows.
 *
 * @param {string} region
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchStartupTrends(region) {
  if (region !== 'Global') return [];

  const summaries = await fetchStartupItems();

  if (summaries.length === 0) {
    logger.warn('[StartupsFetcher] No items collected — skipping LLM call');
    return [];
  }

  logger.info(`[StartupsFetcher] ${summaries.length} item(s) collected, calling LLM…`);

  const startups = await extractRisingStartups(summaries);

  if (startups.length === 0) {
    logger.warn('[StartupsFetcher] LLM returned no startups');
    return [];
  }

  logger.info(`[StartupsFetcher] Extracted ${startups.length} rising startup(s)`);

  return startups.map((s) => ({
    title:       String(s.title       || '').slice(0, 255),
    description: String(s.description || ''),
    source:      'startups_rss',
    region:      'Global',
    lang:        'en',
  }));
}

module.exports = { fetchStartupTrends };
