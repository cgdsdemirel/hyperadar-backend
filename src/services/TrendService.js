'use strict';

const logger = require('../utils/logger');

const FALLBACK_RESULT = [{
  title:             'No data yet',
  description:       'Not enough trend data available. Try again later.',
  score:             0,
  monetization_hint: '',
  category:          null,
  region:            'Global',
  lang:              null,
  source:            null,
  created_at:        new Date(),
}];

class TrendService {
  /**
   * @param {import('pg').Pool} db
   */
  constructor(db) {
    this.db = db;
  }

  // ─────────────────────────────────────────
  // Write
  // ─────────────────────────────────────────

  /**
   * Bulk-insert enriched trend records from the pipeline.
   *
   * Uses a multi-row VALUES list for efficiency. Each trend must have:
   *   title, description, category, region, lang, score, monetization_hint, source
   *
   * @param {object[]} trends
   * @returns {Promise<number>} Number of rows inserted
   */
  async saveTrends(trends) {
    if (!trends || trends.length === 0) return 0;

    // Build parameterised multi-row INSERT
    const values  = [];
    const params  = [];
    let   counter = 1;

    for (const t of trends) {
      values.push(
        `($${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++})`
      );
      params.push(
        t.title,
        t.description        || null,
        t.category           || null,
        t.region             || null,
        t.lang               || null,
        t.score              ?? null,
        t.monetization_hint  || null,
        t.source             || null,
      );
    }

    const sql = `
      INSERT INTO trends
        (title, description, category, region, lang, score, monetization_hint, source)
      VALUES ${values.join(', ')}
    `;

    const result = await this.db.query(sql, params);
    return result.rowCount;
  }

  // ─────────────────────────────────────────
  // Read
  // ─────────────────────────────────────────

  /**
   * Fetch the top 5 trends for the requested regions and categories.
   *
   * Deduplication: only the highest-scoring row per title is returned.
   * Fallback chain:
   *   1. Match requested regions + categories  → up to 5 rows
   *   2. If empty, retry with region = 'Global'
   *   3. If still empty, return FALLBACK_RESULT
   *
   * @param {string[]} regions    - e.g. ['Turkiye', 'Global']
   * @param {string[]} categories - e.g. ['youtube', 'reddit']
   * @returns {Promise<object[]>}
   */
  async getTrends(regions, categories) {
    const rows = await this._query(regions, categories);
    if (rows.length > 0) return rows;

    logger.warn(`[TrendService] No results for regions=${JSON.stringify(regions)}, falling back to Global`);
    const globalRows = await this._query(['Global'], categories);
    if (globalRows.length > 0) return globalRows;

    logger.warn('[TrendService] No results even for Global — returning fallback');
    return FALLBACK_RESULT;
  }

  /**
   * Internal query: deduplicated by title (highest score wins), ordered by score DESC.
   * @private
   */
  async _query(regions, categories) {
    const { rows } = await this.db.query(
      `WITH ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY title
                  ORDER BY score DESC, created_at DESC
                ) AS rn
           FROM trends
          WHERE region   = ANY($1::varchar[])
            AND category = ANY($2::varchar[])
       )
       SELECT id, title, description, category, region, lang,
              score, monetization_hint, source, created_at
         FROM ranked
        WHERE rn = 1
        ORDER BY score DESC, created_at DESC
        LIMIT 5`,
      [regions, categories]
    );
    return rows;
  }

  // ─────────────────────────────────────────
  // Maintenance (Phase 4+)
  // ─────────────────────────────────────────

  /**
   * Retrieve trends for a specific query (used by QueryService in Phase 4).
   * @param {string} queryId
   * @returns {Promise<object[]>}
   */
  async getTrendsByQuery(queryId) {
    // TODO (Phase 4): implement join between queries and trends
    throw new Error('Not implemented');
  }

  /**
   * Delete trends older than a given date (maintenance / TTL cleanup).
   * @param {Date} olderThan
   * @returns {Promise<number>} Rows deleted
   */
  async expireTrends(olderThan) {
    // TODO (Phase 4): implement scheduled cleanup
    throw new Error('Not implemented');
  }
}

module.exports = { TrendService };
