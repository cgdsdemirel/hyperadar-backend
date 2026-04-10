'use strict';

const axios  = require('axios');
const logger = require('../../utils/logger');

// ─── Subreddit & language maps ────────────────────────────────────────────────

const SUBREDDIT_MAP = {
  Global:   'all',
  Turkiye:  'Turkey',
  Almanya:  'de',
  Hindistan:'india',
  ABD:      'all',     // best-effort for US — r/all biased toward US content
};

const LANG_MAP = {
  Global:   'en',
  Turkiye:  'tr',
  Almanya:  'de',
  Hindistan:'hi',
  ABD:      'en',
};

const MAX_RESULTS    = 10;
const REDDIT_AUTH    = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API     = 'https://oauth.reddit.com';
const USER_AGENT     = 'HypeRadar/1.0 (pipeline bot; contact your-email@example.com)';

/**
 * Obtain a short-lived Reddit access token via OAuth2 client credentials.
 * @returns {Promise<string>} Bearer access token
 */
async function getRedditToken() {
  const credentials = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post(
    REDDIT_AUTH,
    'grant_type=client_credentials',
    {
      timeout: 10_000,
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   USER_AGENT,
      },
    }
  );

  return data.access_token;
}

/**
 * Fetch the top hot posts from the appropriate subreddit for a HypeRadar region.
 *
 * @param {string} region - One of: Global | ABD | Turkiye | Almanya | Hindistan
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchRedditTrends(region) {
  try {
    const subreddit = SUBREDDIT_MAP[region] ?? 'all';
    const lang      = LANG_MAP[region]      ?? 'en';

    const token = await getRedditToken();

    const { data } = await axios.get(
      `${REDDIT_API}/r/${subreddit}/hot`,
      {
        timeout: 10_000,
        params:  { limit: MAX_RESULTS },
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent':  USER_AGENT,
        },
      }
    );

    const posts = data?.data?.children || [];

    return posts.map(({ data: post }) => ({
      title:       post.title    || '',
      description: post.selftext || post.url || '',
      source:      'reddit',
      region,
      lang,
    }));
  } catch (err) {
    logger.error(`[RedditFetcher] Failed for region="${region}"`, err);
    return [];
  }
}

module.exports = { fetchRedditTrends };
