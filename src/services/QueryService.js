'use strict';

const logger = require('../utils/logger');
const {
  ValidationError,
  PlanLimitError,
  InsufficientTokensError,
  NotFoundError,
} = require('../utils/errors');

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_REGIONS    = new Set(['Global', 'ABD', 'Turkiye', 'Almanya', 'Hindistan']);
const ALLOWED_CATEGORIES = new Set(['youtube', 'github', 'ai_tools', 'reddit']);

/** How many trends each plan tier sees in a response */
const TREND_LIMIT = { free: 1, premium: 5 };

/** Total trends available — used to compute unlock_more.trends_remaining */
const TOTAL_TRENDS_AVAILABLE = 5;

class QueryService {
  /**
   * @param {import('pg').Pool}                        db
   * @param {import('./TokenService').TokenService}     tokenService
   * @param {import('./TrendService').TrendService}     trendService
   */
  constructor(db, tokenService, trendService) {
    this.db           = db;
    this.tokenService = tokenService;
    this.trendService = trendService;
  }

  // ─────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────

  /**
   * Execute a trend query for an authenticated user.
   *
   * Flow:
   *   1. Validate input (types + allowed values)
   *   2. Load user, enforce plan-tier limits
   *   3. Calculate token cost
   *   4. Deduct tokens (premium only)
   *   5. Fetch trends from DB (never triggers a live pipeline run)
   *   6. Slice results by plan
   *   7. Persist query log
   *   8. Return shaped response
   *
   * @param {string}   userId
   * @param {string[]} regions
   * @param {string[]} categories
   * @param {string}   [lang='en'] - Language of trends to return ('en' or 'tr')
   * @returns {Promise<object>} Shaped query response
   */
  async executeQuery(userId, regions, categories, lang = 'en') {
    // ── Step 1: validate input ────────────────────────────────────────────────
    this._validateInput(regions, categories);

    // ── Step 2: load user + enforce plan limits ───────────────────────────────
    const user = await this._getUser(userId);
    this._enforcePlanLimits(user.plan, regions, categories);

    const isPremium = user.plan === 'premium';

    // ── Step 3: calculate cost ────────────────────────────────────────────────
    const tokenCost = this.tokenService.calculateQueryCost(categories);

    // ── Step 4: deduct tokens (premium only) ──────────────────────────────────
    let remainingTokens = null;

    if (isPremium) {
      // deductTokens throws InsufficientTokensError — let it propagate to controller
      const balance = await this.tokenService.deductTokens(userId, tokenCost);
      remainingTokens = balance.monthly_tokens + balance.purchased_tokens;
    }

    // ── Step 5: fetch trends (always from DB — no live pipeline call) ─────────
    const allTrends = await this.trendService.getTrends(regions, categories, lang);

    // ── Step 6: slice by plan ─────────────────────────────────────────────────
    const limit  = TREND_LIMIT[user.plan] ?? TREND_LIMIT.free;
    const slice  = allTrends.slice(0, limit);

    // ── Step 6b: annotate with the user's favorited status ───────────────────
    const trends = await this._annotateFavorites(userId, slice);

    // ── Step 7: persist query log ─────────────────────────────────────────────
    const tokenSpent = isPremium ? tokenCost : 0;
    const queryId    = await this._logQuery(userId, regions, categories, tokenSpent);

    logger.info(
      `[QueryService] query=${queryId} user=${userId} plan=${user.plan} ` +
      `regions=${regions.join(',')} categories=${categories.join(',')} lang=${lang} ` +
      `token_spent=${tokenSpent} trends_returned=${trends.length}`
    );

    // ── Step 8: shape response ────────────────────────────────────────────────
    return this._buildResponse({ trends, tokenSpent, isPremium, remainingTokens });
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────

  /**
   * Validate types and allowed values.
   * Middleware already guards the HTTP layer; this protects direct service calls.
   */
  _validateInput(regions, categories) {
    if (!Array.isArray(regions) || regions.length < 1 || regions.length > 2) {
      throw new ValidationError('regions must be an array with 1 or 2 items');
    }
    if (!Array.isArray(categories) || categories.length < 1 || categories.length > 2) {
      throw new ValidationError('categories must be an array with 1 or 2 items');
    }

    const badRegion = regions.find((r) => !ALLOWED_REGIONS.has(r));
    if (badRegion) {
      throw new ValidationError(
        `Invalid region "${badRegion}". Allowed: ${[...ALLOWED_REGIONS].join(', ')}`
      );
    }

    const badCategory = categories.find((c) => !ALLOWED_CATEGORIES.has(c));
    if (badCategory) {
      throw new ValidationError(
        `Invalid category "${badCategory}". Allowed: ${[...ALLOWED_CATEGORIES].join(', ')}`
      );
    }
  }

  /** Fetch user row; throw NotFoundError if missing. */
  async _getUser(userId) {
    const { rows } = await this.db.query(
      'SELECT id, email, plan FROM users WHERE id = $1',
      [userId]
    );
    if (rows.length === 0) throw new NotFoundError('User');
    return rows[0];
  }

  /**
   * Enforce per-plan query limits.
   *
   * Free plan:    max 1 region, max 1 category.
   * Premium plan: max 2 regions, max 2 categories (already capped by input validation).
   */
  _enforcePlanLimits(plan, regions, categories) {
    if (plan === 'free') {
      if (regions.length > 1) {
        throw new PlanLimitError(
          'Free plan allows only 1 region per query. Upgrade to premium for up to 2 regions.'
        );
      }
      if (categories.length > 1) {
        throw new PlanLimitError(
          'Free plan allows only 1 category per query. Upgrade to premium for up to 2 categories.'
        );
      }
    }
    // Premium: no additional restriction beyond input validation (max 2)
  }

  /** Insert a query log row and return the generated query ID. */
  async _logQuery(userId, regions, categories, tokenSpent) {
    const { rows } = await this.db.query(
      `INSERT INTO queries (user_id, regions, categories, token_spent)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, regions, categories, tokenSpent]
    );
    return rows[0].id;
  }

  /**
   * Build the final response object.
   *
   * Free:    { trends, token_spent: 0, unlock_more }
   * Premium: { trends, token_spent, remaining_tokens }
   */
  _buildResponse({ trends, tokenSpent, isPremium, remainingTokens }) {
    if (isPremium) {
      return {
        trends,
        token_spent:      tokenSpent,
        remaining_tokens: remainingTokens,
      };
    }

    // Free tier: expose how many more trends are locked behind an ad/upgrade
    const trendsReturned   = trends.length;
    const trendsRemaining  = Math.max(0, TOTAL_TRENDS_AVAILABLE - trendsReturned);

    return {
      trends,
      token_spent: 0,
      unlock_more: {
        ad_required:       true,
        trends_remaining:  trendsRemaining,
      },
    };
  }

  // ─────────────────────────────────────────
  // Private helpers (continued)
  // ─────────────────────────────────────────

  /**
   * Annotate each trend with a `favorited` boolean for the given user.
   * Non-fatal: returns trends unchanged (with favorited=false) on any DB error.
   *
   * @param {string}   userId
   * @param {object[]} trends - Array of trend objects with `id` field
   * @returns {Promise<object[]>}
   */
  async _annotateFavorites(userId, trends) {
    if (trends.length === 0) return trends;

    const trendIds = trends.map((t) => t.id).filter(Boolean);
    if (trendIds.length === 0) return trends.map((t) => ({ ...t, favorited: false }));

    try {
      const { rows } = await this.db.query(
        `SELECT trend_id FROM favorites WHERE user_id = $1 AND trend_id = ANY($2::uuid[])`,
        [userId, trendIds]
      );
      const favorited = new Set(rows.map((r) => r.trend_id));
      return trends.map((t) => ({ ...t, favorited: favorited.has(t.id) }));
    } catch (err) {
      logger.warn(
        `[QueryService] _annotateFavorites failed for user=${userId}: ${err.message}`
      );
      return trends.map((t) => ({ ...t, favorited: false }));
    }
  }

  // ─────────────────────────────────────────
  // TODO (Phase 5)
  // ─────────────────────────────────────────

  /**
   * Retrieve paginated query history for a user.
   * @param {string} userId
   * @param {{ page?: number, limit?: number }} options
   */
  async getQueryHistory(userId, options = {}) {
    // TODO (Phase 5): implement
    throw new Error('Not implemented');
  }

  /**
   * Fetch a single query log by ID, scoped to the owner.
   * @param {string} userId
   * @param {string} queryId
   */
  async getQueryById(userId, queryId) {
    // TODO (Phase 5): implement
    throw new Error('Not implemented');
  }
}

module.exports = { QueryService };
