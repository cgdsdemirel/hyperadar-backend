'use strict';

const logger = require('../utils/logger');
const {
  ValidationError,
  PlanLimitError,
  InsufficientTokensError,
} = require('../utils/errors');

/**
 * QueryController — HTTP adapter over QueryService.
 *
 * All business logic lives in QueryService. This controller only:
 *   - Extracts request fields
 *   - Calls the service
 *   - Maps known errors to HTTP status codes
 *   - Passes unknown errors to the central error handler
 */

/**
 * POST /query
 *
 * Requires: authenticate middleware (req.user.id populated)
 * Requires: validateQueryInput middleware (structural validation already done)
 *
 * Body:    { regions: string[], categories: string[], lang?: string }
 * Success: 200 { trends, token_spent, remaining_tokens? | unlock_more? }
 *
 * Errors:
 *   ValidationError         → 400 { error }
 *   PlanLimitError          → 403 { error }
 *   InsufficientTokensError → 402 { error, remaining }
 *   anything else           → 500 via next(err)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function execute(req, res, next) {
  try {
    const userId                   = req.user.id;
    const { regions, categories, lang } = req.body;

    const { queryService } = req.app.locals;
    const result = await queryService.executeQuery(userId, regions, categories, lang);

    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof PlanLimitError) {
      return res.status(403).json({ error: err.message });
    }
    if (err instanceof InsufficientTokensError) {
      return res.status(402).json({
        error:     'Insufficient tokens',
        remaining: err.remaining,
      });
    }

    // Unexpected — log and hand off to the global error handler
    logger.error('[QueryController] Unhandled error in POST /query', err);
    next(err);
  }
}

module.exports = { execute };
