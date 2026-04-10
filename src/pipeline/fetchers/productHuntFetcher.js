'use strict';

const axios  = require('axios');
const logger = require('../../utils/logger');

const GQL_ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';

const QUERY = `
  query TodaysPosts {
    posts(first: 10, order: VOTES) {
      edges {
        node {
          name
          tagline
          description
        }
      }
    }
  }
`;

/**
 * Fetch the top 10 trending products on Product Hunt (global, today).
 *
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchProductHuntTrends() {
  try {
    const { data } = await axios.post(
      GQL_ENDPOINT,
      { query: QUERY },
      {
        timeout: 15_000,
        headers: {
          Authorization:  `Bearer ${process.env.PRODUCT_HUNT_API_KEY}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
        },
      }
    );

    const edges = data?.data?.posts?.edges || [];

    return edges.map(({ node }) => ({
      title:       node.name     || '',
      description: node.tagline || node.description || '',
      source:      'producthunt',
      region:      'Global',
      lang:        'en',
    }));
  } catch (err) {
    logger.error('[ProductHuntFetcher] Failed', err);
    return [];
  }
}

module.exports = { fetchProductHuntTrends };
