'use strict';

const Parser = require('rss-parser');
const logger = require('../../utils/logger');

const parser = new Parser({ timeout: 15_000 });

const FEEDS = [
  { url: 'https://techcrunch.com/feed/', filter: true  }, // AI-only filter
  { url: 'https://feeds.feedburner.com/venturebeat/SZYF', filter: false },
];

const AI_KEYWORDS = /\bai\b|artificial intelligence/i;

/**
 * Fetch AI/tech trends from RSS feeds.
 *
 * TechCrunch items are filtered to only include posts that mention
 * "AI" or "artificial intelligence" in title or content snippet.
 * VentureBeat (AI-focused feed) is included without filtering.
 *
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchRssTrends() {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        const text = `${item.title || ''} ${item.contentSnippet || ''}`;

        if (feed.filter && !AI_KEYWORDS.test(text)) continue;

        results.push({
          title:       item.title           || '',
          description: item.contentSnippet  || item.summary || '',
          source:      'rss',
          region:      'Global',
          lang:        'en',
        });
      }
    } catch (err) {
      logger.error(`[RSSFetcher] Failed for feed "${feed.url}"`, err);
      // Continue to next feed — never abort the whole batch
    }
  }

  return results;
}

module.exports = { fetchRssTrends };
