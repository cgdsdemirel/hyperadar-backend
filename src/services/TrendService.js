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
   * Fetch the top trends for the requested regions, categories, and language.
   *
   * Returns up to `perCategoryLimit` results per category so that selecting
   * two categories always yields results from both (not just the highest-scoring one).
   *
   * Deduplication: only the highest-scoring row per title is returned.
   * Fallback chain:
   *   1. Match requested regions + categories + lang → up to perCategoryLimit rows/category
   *   2. If empty, retry with region = 'Global'
   *   3. If still empty, return FALLBACK_RESULT
   *
   * @param {string[]} regions          - e.g. ['Turkiye', 'Global']
   * @param {string[]} categories       - e.g. ['youtube', 'reddit']
   * @param {string}   [lang='en']      - Language filter, e.g. 'en' or 'tr'
   * @param {number}   [perCategoryLimit=5] - Max results per category
   * @returns {Promise<object[]>}
   */
  async getTrends(regions, categories, lang = 'en', perCategoryLimit = 5) {
    // 1. Exact match: requested regions + lang
    const rows = await this._query(regions, categories, lang, perCategoryLimit);
    if (rows.length > 0) return rows;

    // 2. Lang fallback: same regions, try 'en' (pipeline may not have run for this lang yet)
    if (lang !== 'en') {
      logger.warn(`[TrendService] No results for regions=${JSON.stringify(regions)} lang=${lang}, retrying with lang=en`);
      const enRows = await this._query(regions, categories, 'en', perCategoryLimit);
      if (enRows.length > 0) return enRows;
    }

    // 3. Region fallback: try Global with original lang
    logger.warn(`[TrendService] No results for regions=${JSON.stringify(regions)} lang=${lang}, falling back to Global`);
    const globalRows = await this._query(['Global'], categories, lang, perCategoryLimit);
    if (globalRows.length > 0) return globalRows;

    // 4. Global + en
    if (lang !== 'en') {
      const globalEnRows = await this._query(['Global'], categories, 'en', perCategoryLimit);
      if (globalEnRows.length > 0) return globalEnRows;
    }

    logger.warn('[TrendService] No results for any fallback combination — returning placeholder');
    return FALLBACK_RESULT;
  }

  /**
   * Like getTrends but filters out trends the user has already seen within
   * the last 7 days, unless the trend's score has surged 40%+ since last view.
   *
   * @param {string}   userId
   * @param {string[]} regions
   * @param {string[]} categories
   * @param {string}   lang
   * @param {number}   perCategoryLimit
   * @param {boolean}  [includeSeen=false] - When true, behaves exactly like getTrends
   * @returns {Promise<{ trends: object[], availableFreshCount: number }>}
   */
  async getTrendsWithSeenFilter(userId, regions, categories, lang, perCategoryLimit, includeSeen = false) {
    const SEEN_WINDOW_DAYS = 7;
    const SURGE_THRESHOLD = 1.4;

    // If includeSeen is true, behave exactly like getTrends (ignore seen_trends)
    if (includeSeen) {
      const trends = await this.getTrends(regions, categories, lang, perCategoryLimit);
      return { trends, availableFreshCount: trends.length };
    }

    // Fetch top 15 per category, then filter
    const POOL_SIZE = 15;
    const rawTrends = await this.getTrends(regions, categories, lang, POOL_SIZE);

    if (rawTrends.length === 0) {
      return { trends: [], availableFreshCount: 0 };
    }

    // Get seen records for this user in last 7 days
    const trendIds = rawTrends.map(t => t.id);
    const { rows: seenRows } = await this.db.query(
      `SELECT trend_id, score_at_view, seen_at
         FROM seen_trends
        WHERE user_id = $1
          AND trend_id = ANY($2)
          AND seen_at > NOW() - INTERVAL '${SEEN_WINDOW_DAYS} days'`,
      [userId, trendIds]
    );

    const seenMap = new Map();
    for (const row of seenRows) {
      seenMap.set(row.trend_id, row);
    }

    // Filter: keep unseen, OR seen-but-surged (40%+ score increase)
    const filtered = [];
    for (const trend of rawTrends) {
      const seen = seenMap.get(trend.id);
      if (!seen) {
        filtered.push(trend);
        continue;
      }
      const prevScore = Number(seen.score_at_view) || 0;
      const currScore = Number(trend.score) || 0;
      if (prevScore > 0 && currScore >= prevScore * SURGE_THRESHOLD) {
        filtered.push({ ...trend, is_resurgent: true, prev_score: prevScore });
      }
    }

    // Group by category and limit per category
    const byCategory = new Map();
    for (const t of filtered) {
      if (!byCategory.has(t.category)) byCategory.set(t.category, []);
      byCategory.get(t.category).push(t);
    }

    const result = [];
    for (const cat of categories) {
      const slice = (byCategory.get(cat) || []).slice(0, perCategoryLimit);
      result.push(...slice);
    }

    return { trends: result, availableFreshCount: result.length };
  }

  /**
   * Record which trends were shown to a user (upsert, ignore duplicates).
   * @param {string}   userId
   * @param {object[]} trends - Array of trend objects with id and score
   */
  async recordSeenTrends(userId, trends) {
    if (!trends || trends.length === 0) return;

    const values = [];
    const params = [];
    let p = 1;
    for (const t of trends) {
      if (!t.id || t.score == null) continue;
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(userId, t.id, t.score);
    }
    if (values.length === 0) return;

    await this.db.query(
      `INSERT INTO seen_trends (user_id, trend_id, score_at_view)
       VALUES ${values.join(', ')}
       ON CONFLICT DO NOTHING`,
      params
    );
  }

  /**
   * Internal query: deduplicated by title (highest score wins),
   * then limited to perCategoryLimit rows per category.
   * @private
   */
  async _query(regions, categories, lang, perCategoryLimit = 5) {
    const { rows } = await this.db.query(
      `WITH deduped AS (
         -- Keep only the highest-scoring row per unique title
         SELECT DISTINCT ON (title)
                id, title, description, category, region, lang,
                score, monetization_hint, source, created_at
           FROM trends
          WHERE region   = ANY($1::varchar[])
            AND category = ANY($2::varchar[])
            AND lang     = $3
          ORDER BY title, score DESC, created_at DESC
       ),
       ranked AS (
         -- Rank within each category so we can slice per-category
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY category
                  ORDER BY score DESC, created_at DESC
                ) AS cat_rn
           FROM deduped
       )
       SELECT id, title, description, category, region, lang,
              score, monetization_hint, source, created_at
         FROM ranked
        WHERE cat_rn <= $4
        ORDER BY category, score DESC, created_at DESC`,
      [regions, categories, lang, perCategoryLimit]
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
