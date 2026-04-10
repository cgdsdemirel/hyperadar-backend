'use strict';

// TODO: Import Anthropic SDK, YouTube API client, Reddit client, Product Hunt client

/**
 * PipelineService — fetches raw trend signals from external sources,
 * scores them with Claude, and returns structured trend objects.
 *
 * Data sources (Phase 3+):
 *   - YouTube Data API v3  (trending videos by region/category)
 *   - Reddit API           (rising posts from relevant subreddits)
 *   - Product Hunt API     (trending products)
 *   - Claude (claude-sonnet-4-6) for scoring and monetization hints
 *
 * TODO (Phase 3):
 *   - run({ regions, categories }):
 *       1. Fetch raw signals from all sources in parallel
 *       2. Deduplicate and normalize signals
 *       3. Send normalized signals to Claude for scoring (score 0–100) and
 *          generating monetization_hint
 *       4. Return array of trend objects matching the `trends` table schema
 *
 *   - fetchYouTubeTrends(region, category): call YouTube API
 *   - fetchRedditTrends(category): call Reddit API
 *   - fetchProductHuntTrends(): call Product Hunt API
 *   - scoreWithClaude(signals[]): call Anthropic SDK, parse structured response
 */
class PipelineService {
  /**
   * @param {object} config
   * @param {string} config.anthropicApiKey
   * @param {string} config.youtubeApiKey
   * @param {string} config.redditClientId
   * @param {string} config.redditClientSecret
   * @param {string} config.productHuntApiKey
   */
  constructor(config) {
    this.config = config;
    // TODO: instantiate Anthropic client and source clients
  }

  /**
   * Main pipeline entry point. Runs all sources and returns scored trends.
   * @param {{ regions: string[], categories: string[] }} params
   * @returns {Promise<object[]>} Array of scored trend objects
   */
  async run(params) {
    // TODO: implement parallel fetch + Claude scoring
    throw new Error('Not implemented');
  }

  /**
   * Fetch trending YouTube videos for a given region and category.
   * @param {string} region - ISO 3166-1 alpha-2 country code (e.g. 'US')
   * @param {string} category
   * @returns {Promise<object[]>} Raw signal objects
   */
  async fetchYouTubeTrends(region, category) {
    // TODO: implement YouTube Data API v3 call
    throw new Error('Not implemented');
  }

  /**
   * Fetch rising Reddit posts for a given category.
   * @param {string} category
   * @returns {Promise<object[]>} Raw signal objects
   */
  async fetchRedditTrends(category) {
    // TODO: implement Reddit API call
    throw new Error('Not implemented');
  }

  /**
   * Fetch trending products from Product Hunt.
   * @returns {Promise<object[]>} Raw signal objects
   */
  async fetchProductHuntTrends() {
    // TODO: implement Product Hunt API call
    throw new Error('Not implemented');
  }

  /**
   * Score raw signals using Claude and generate monetization hints.
   * @param {object[]} signals
   * @returns {Promise<object[]>} Scored trend objects with monetization_hint
   */
  async scoreWithClaude(signals) {
    // TODO: call @anthropic-ai/sdk, parse structured JSON response
    throw new Error('Not implemented');
  }
}

module.exports = { PipelineService };
