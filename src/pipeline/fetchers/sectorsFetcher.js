'use strict';

/**
 * Rising Sectors fetcher.
 *
 * Flow:
 *   1. Pull headlines from TechCrunch + Bloomberg RSS feeds
 *   2. Send up to MAX_HEADLINES to Claude in a single aggregated call
 *   3. Claude returns 5 rising industry sectors (title, description, score)
 *   4. Return normalised raw items — the standard enricher loop in pipeline.js
 *      then produces bilingual (EN + TR) enriched records for the DB
 */

const Parser   = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const logger   = require('../../utils/logger');

const parser = new Parser({ timeout: 15_000 });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Feed list ────────────────────────────────────────────────────────────────
// Bloomberg public RSS feeds are frequently restricted; multiple URLs are tried
// in order so failures fall through gracefully.

const FEEDS = [
  'https://feeds.feedburner.com/TechCrunch',
  'https://www.bloomberg.com/feed/podcast/etf-iq.xml',
  'https://feeds.bloomberg.com/technology/news.rss',
  'https://feeds.bloomberg.com/markets/news.rss',
];

const MAX_HEADLINES    = 30;  // cap sent to the LLM to manage token usage
const ITEMS_PER_FEED   = 15;  // max items read from each feed

// ─── Headline collection ──────────────────────────────────────────────────────

/**
 * Fetch and concatenate headlines from all configured feeds.
 * Failures on individual feeds are logged and skipped — never abort the batch.
 *
 * @returns {Promise<string[]>} Up to MAX_HEADLINES "Title: snippet" strings
 */
async function fetchHeadlines() {
  const headlines = [];

  for (const url of FEEDS) {
    try {
      const parsed = await parser.parseURL(url);

      for (const item of (parsed.items || []).slice(0, ITEMS_PER_FEED)) {
        const title   = (item.title         || '').trim();
        const snippet = (item.contentSnippet || item.summary || '').trim().slice(0, 200);

        if (!title) continue;
        headlines.push(snippet ? `${title}: ${snippet}` : title);
      }

      logger.info(`[SectorsFetcher] "${url}" — ${parsed.items?.length ?? 0} items`);
    } catch (err) {
      // Non-fatal: Bloomberg feeds often return 403 — the TechCrunch feed alone
      // is sufficient for a useful signal.
      logger.warn(`[SectorsFetcher] Feed "${url}" failed — ${err.message}`);
    }
  }

  return headlines.slice(0, MAX_HEADLINES);
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

/**
 * Ask Claude to identify 5 rising industry sectors from the collected headlines.
 *
 * Returns a max of 5 parsed sector objects.
 * One automatic retry on JSON-parse failure, then returns [] so the pipeline
 * can skip gracefully rather than crashing the whole run.
 *
 * @param {string[]} headlines
 * @returns {Promise<Array<{ title: string, description: string, score: number }>>}
 */
async function extractSectors(headlines) {
  const numbered = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

  const prompt =
    'From these news headlines, identify 5 rising industry sectors showing growth signals. ' +
    'For each return: title (sector name), description (why it\'s rising, 2 sentences), ' +
    'score (1-100 based on signal strength).\n\n' +
    `Headlines:\n${numbered}\n\n` +
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
        logger.warn(`[SectorsFetcher] LLM attempt 1 failed — ${err.message}, retrying…`);
      } else {
        logger.error(`[SectorsFetcher] Both LLM attempts failed — ${err.message}`, err);
      }
    }
  }

  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch rising sector trends.
 *
 * Returns [] for every region except 'Global' — sector signals are
 * aggregated from global news sources, so running per-region would just
 * produce the same data five times.
 *
 * The returned shape matches what other fetchers return:
 *   { title, description, source, region, lang }
 * The pipeline adds `category` and later calls `enrich()` to produce
 * bilingual, scored, and monetization-hinted records for the DB.
 *
 * @param {string} region
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchSectorTrends(region) {
  if (region !== 'Global') return [];

  const headlines = await fetchHeadlines();

  if (headlines.length === 0) {
    logger.warn('[SectorsFetcher] No headlines collected — skipping LLM call');
    return [];
  }

  logger.info(`[SectorsFetcher] Sending ${headlines.length} headlines to LLM…`);

  const sectors = await extractSectors(headlines);

  if (sectors.length === 0) {
    logger.warn('[SectorsFetcher] LLM returned no sectors');
    return [];
  }

  logger.info(`[SectorsFetcher] Extracted ${sectors.length} sector signal(s)`);

  return sectors.map((s) => ({
    title:       String(s.title       || '').slice(0, 255),
    description: String(s.description || ''),
    source:      'sectors_rss',
    region:      'Global',
    lang:        'en',
  }));
}

module.exports = { fetchSectorTrends };
