'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../../utils/logger');

// ─── Language maps ────────────────────────────────────────────────────────────

/** HypeRadar region → GitHub spoken_language_code */
const REGION_LANG_MAP = {
  Turkiye:  'tr',
  ABD:      'en',
  Almanya:  'de',
  Hindistan:'hi',
  Global:   '',
};

const BASE_URL = 'https://github.com/trending';

/**
 * Scrape GitHub Trending for a given HypeRadar region (mapped to spoken language).
 *
 * @param {string} region - One of: Global | ABD | Turkiye | Almanya | Hindistan
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchGithubTrends(region) {
  try {
    const lang = REGION_LANG_MAP[region] ?? '';

    const url = lang
      ? `${BASE_URL}?spoken_language_code=${lang}`
      : BASE_URL;

    const { data: html } = await axios.get(url, {
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (HypeRadar pipeline bot)' },
    });

    const $       = cheerio.load(html);
    const results = [];

    // Each trending repo is an <article class="Box-row">
    $('article.Box-row').each((_, el) => {
      // Repo title: <h2 class="h3 lh-condensed"><a href="/owner/repo">
      const rawTitle = $(el).find('h2 a').text().replace(/\s+/g, ' ').trim();
      // Description: <p class="col-9 ...">
      const desc     = $(el).find('p').first().text().trim();

      if (!rawTitle) return;

      results.push({
        title:       rawTitle,
        description: desc || 'Trending repository on GitHub',
        source:      'github',
        region,
        lang:        lang || 'en',
      });
    });

    return results;
  } catch (err) {
    logger.error(`[GitHubFetcher] Failed for region="${region}"`, err);
    return [];
  }
}

module.exports = { fetchGithubTrends };
