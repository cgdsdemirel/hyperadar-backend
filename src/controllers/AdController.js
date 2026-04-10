'use strict';

const logger = require('../utils/logger');
const { AdCooldownError, PlanLimitError } = require('../utils/errors');

/**
 * AdController — HTTP adapter over AdService.
 *
 * Never trusts the client for ad completion state. The only source of truth
 * is the server-side cooldown check + ad_views insert in AdService.
 */

/**
 * POST /ads/complete
 *
 * Body (optional): { query_id: string }
 *
 * Success 200: { success: true, reward: "query_unlocked" }
 *
 * Errors:
 *   PlanLimitError  (premium user)  → 403
 *   AdCooldownError                 → 429
 *   anything else                   → 500 via next(err)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function complete(req, res, next) {
  try {
    const userId  = req.user.id;
    const queryId = req.body?.query_id ?? null;

    const { adService } = req.app.locals;
    const result = await adService.completeAd(userId, queryId);

    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof PlanLimitError) {
      return res.status(403).json({ error: err.message });
    }
    if (err instanceof AdCooldownError) {
      return res.status(429).json({ error: err.message });
    }
    logger.error('[AdController] Unhandled error in POST /ads/complete', err);
    next(err);
  }
}

module.exports = { complete };
