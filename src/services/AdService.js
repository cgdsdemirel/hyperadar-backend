'use strict';

const logger = require('../utils/logger');
const { AdCooldownError, PlanLimitError, NotFoundError } = require('../utils/errors');

/** Seconds a user must wait between ad views (anti-farming) */
const COOLDOWN_SECONDS = 30;

class AdService {
  /**
   * @param {import('pg').Pool} db
   */
  constructor(db) {
    this.db = db;
  }

  // ─────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────

  /**
   * Record a completed ad view for a free-tier user.
   *
   * Flow:
   *   1. Validate user exists + is free plan
   *   2. Enforce 30-second cooldown (anti-farming)
   *   3. Insert ad_views row (with optional queryId)
   *   4. Return reward signal
   *
   * The reward "query_unlocked" is a signal to the mobile client to re-fetch
   * the full query results. No tokens are transferred — the ad completion
   * itself is the gate that the API checks when returning results (Phase 6).
   *
   * @param {string}      userId
   * @param {string|null} queryId - Optional: the query that prompted the ad
   * @returns {Promise<{ success: true, reward: 'query_unlocked' }>}
   */
  async completeAd(userId, queryId = null) {
    // ── Step 1: validate user ─────────────────────────────────────────────────
    const user = await this._getUser(userId);

    if (user.plan === 'premium') {
      throw new PlanLimitError('Premium users do not need ads');
    }

    // ── Validate queryId if provided ─────────────────────────────────────────
    if (queryId !== null && queryId !== undefined) {
      await this._validateQueryExists(queryId, userId);
    }

    // ── Step 2: cooldown check ────────────────────────────────────────────────
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_SECONDS * 1000);

    const { rows: recentViews } = await this.db.query(
      `SELECT id FROM ad_views
        WHERE user_id     = $1
          AND completed_at > $2
        LIMIT 1`,
      [userId, cooldownCutoff]
    );

    if (recentViews.length > 0) {
      throw new AdCooldownError('Please wait before watching another ad');
    }

    // ── Step 3: record ad view ────────────────────────────────────────────────
    const { rows } = await this.db.query(
      `INSERT INTO ad_views (user_id, query_id)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, queryId || null]
    );

    logger.info(
      `[AdService] Ad view recorded — user=${userId} view_id=${rows[0].id} query_id=${queryId || 'none'}`
    );

    // ── Step 4: return reward ─────────────────────────────────────────────────
    return { success: true, reward: 'query_unlocked' };
  }

  /**
   * Return how many ads the user has watched today (UTC day).
   *
   * @param {string} userId
   * @returns {Promise<{ ads_watched_today: number }>}
   */
  async getAdStatus(userId) {
    // Start of today UTC
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS count
         FROM ad_views
        WHERE user_id     = $1
          AND completed_at >= $2`,
      [userId, todayUtc]
    );

    return { ads_watched_today: rows[0].count };
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────

  async _getUser(userId) {
    const { rows } = await this.db.query(
      'SELECT id, plan FROM users WHERE id = $1',
      [userId]
    );
    if (rows.length === 0) throw new NotFoundError('User');
    return rows[0];
  }

  /** Confirm a queryId exists and belongs to this user. */
  async _validateQueryExists(queryId, userId) {
    const { rows } = await this.db.query(
      'SELECT id FROM queries WHERE id = $1 AND user_id = $2',
      [queryId, userId]
    );
    if (rows.length === 0) throw new NotFoundError('Query');
  }
}

module.exports = { AdService };
