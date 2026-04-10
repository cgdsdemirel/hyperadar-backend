'use strict';

const axios  = require('axios');
const logger = require('../../utils/logger');

// ─── Region maps ─────────────────────────────────────────────────────────────

/** HypeRadar region name → YouTube regionCode (ISO 3166-1 alpha-2) */
const REGION_CODE_MAP = {
  Turkiye:  'TR',
  ABD:      'US',
  Almanya:  'DE',
  Hindistan:'IN',
  Global:   '',   // empty string = worldwide
};

/** YouTube regionCode → BCP-47 language tag (best-effort) */
const REGION_LANG_MAP = {
  TR: 'tr',
  US: 'en',
  DE: 'de',
  IN: 'hi',
  '': 'en',
};

const MAX_RESULTS = 10;
const BASE_URL    = 'https://www.googleapis.com/youtube/v3/videos';

/**
 * Fetch the most-popular YouTube videos for a given HypeRadar region.
 *
 * @param {string} region - One of: Global | ABD | Turkiye | Almanya | Hindistan
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchYouTubeTrends(region) {
  try {
    const regionCode = REGION_CODE_MAP[region] ?? '';
    const lang       = REGION_LANG_MAP[regionCode] ?? 'en';

    const params = {
      part:       'snippet',
      chart:      'mostPopular',
      maxResults: MAX_RESULTS,
      key:        process.env.YOUTUBE_API_KEY,
    };
    if (regionCode) params.regionCode = regionCode;

    const { data } = await axios.get(BASE_URL, { params, timeout: 10_000 });

    return (data.items || []).map((item) => ({
      title:       item.snippet.title        || '',
      description: item.snippet.description  || '',
      source:      'youtube',
      region,
      lang:        item.snippet.defaultAudioLanguage || lang,
    }));
  } catch (err) {
    logger.error(`[YouTubeFetcher] Failed for region="${region}"`, err);
    return [];
  }
}

module.exports = { fetchYouTubeTrends };
