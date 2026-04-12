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
      RETURNING id, score
    `;

    const result = await this.db.query(sql, params);
    const inserted = result.rows;                    // [{ id, score }, …]

    // Record a score snapshot for every newly inserted trend.
    // Bulk-insert into trend_score_history in one round-trip.
    if (inserted.length > 0) {
      const histVals   = [];
      const histParams = [];
      let   hc         = 1;
      for (const row of inserted) {
        if (row.score == null) continue;             // skip null-score rows
        histVals.push(`($${hc++}, $${hc++})`);
        histParams.push(row.id, row.score);
      }
      if (histVals.length > 0) {
        await this.db.query(
          `INSERT INTO trend_score_history (trend_id, score)
           VALUES ${histVals.join(', ')}`,
          histParams
        );
      }
    }

    return inserted.length;
  }

  // ─────────────────────────────────────────
  // Read
  // ─────────────────────────────────────────

  /**
   * Fetch the top 5 trends for the requested regions, categories, and language.
   *
   * Deduplication: only the highest-scoring row per title is returned.
   * Fallback chain:
   *   1. Match requested regions + categories + lang → up to 5 rows
   *   2. If empty, retry with region = 'Global'
   *   3. If still empty, return FALLBACK_RESULT
   *
   * @param {string[]} regions    - e.g. ['Turkiye', 'Global']
   * @param {string[]} categories - e.g. ['youtube', 'reddit']
   * @param {string}   [lang='en'] - Language filter, e.g. 'en' or 'tr'
   * @returns {Promise<object[]>}
   */
  async getTrends(regions, categories, lang = 'en') {
    const rows = await this._query(regions, categories, lang);
    if (rows.length > 0) return rows;

    logger.warn(`[TrendService] No results for regions=${JSON.stringify(regions)} lang=${lang}, falling back to Global`);
    const globalRows = await this._query(['Global'], categories, lang);
    if (globalRows.length > 0) return globalRows;

    logger.warn('[TrendService] No results even for Global — returning fallback');
    return FALLBACK_RESULT;
  }

  /**
   * Internal query: deduplicated by title (highest score wins), ordered by score DESC.
   * @private
   */
  async _query(regions, categories, lang) {
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
            AND lang     = $3
       )
       SELECT id, title, description, category, region, lang,
              score, monetization_hint, source, created_at
         FROM ranked
        WHERE rn = 1
        ORDER BY score DESC, created_at DESC
        LIMIT 5`,
      [regions, categories, lang]
    );
    return rows;
  }

  /**
   * Fetch a single trend by its UUID. Used by the public deep-link endpoint.
   * Returns null if not found or if id is not a valid UUID.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getTrendById(id) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) return null;

    const { rows } = await this.db.query(
      `SELECT id, title, description, category, region, lang,
              score, monetization_hint, source, created_at
         FROM trends WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Fetch the last 7 score snapshots for a trend, ordered oldest-first.
   * Returns an empty array if the trend has no history or id is invalid.
   * @param {string} trendId
   * @returns {Promise<{ score: number, recorded_at: string }[]>}
   */
  async getScoreHistory(trendId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(trendId)) return [];

    const { rows } = await this.db.query(
      `SELECT score, recorded_at
         FROM trend_score_history
        WHERE trend_id = $1
        ORDER BY recorded_at DESC
        LIMIT 7`,
      [trendId]
    );
    // Return oldest-first so callers can render a left→right chart
    return rows.reverse();
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
