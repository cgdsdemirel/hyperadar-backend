'use strict';

const logger = require('../utils/logger');
const {
  IAPValidationError,
  DuplicateReceiptError,
  NotFoundError,
  PlanLimitError,
} = require('../utils/errors');

/**
 * IAPController — HTTP adapter over IAPService.
 *
 * Security contract:
 *   - Never trust client-provided token amounts. Token amounts come from
 *     token_packages in DB, resolved after server-side receipt verification.
 *   - processed_receipts.transaction_id UNIQUE constraint is the final guard
 *     against double-spend even if the application layer is bypassed.
 */

// ─── Shared error mapper ──────────────────────────────────────────────────────

function handleIAPError(err, res, next) {
  if (err instanceof PlanLimitError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof IAPValidationError) {
    return res.status(400).json({ error: 'Invalid receipt' });
  }
  if (err instanceof DuplicateReceiptError) {
    return res.status(409).json({ error: 'Receipt already processed' });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  logger.error('[IAPController] Unhandled IAP error', err);
  next(err);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /tokens/purchase/apple
 *
 * Body: { receipt_data: string, package_id: string }
 * Success 200: { success: true, tokens_added: number, new_balance: object }
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function purchaseApple(req, res, next) {
  try {
    const { receipt_data, package_id } = req.body;

    if (!receipt_data || !package_id) {
      return res.status(400).json({ error: 'receipt_data and package_id are required' });
    }

    const { iapService } = req.app.locals;
    const result = await iapService.verifyAppleReceipt(req.user.id, receipt_data, package_id);

    return res.status(200).json(result);
  } catch (err) {
    return handleIAPError(err, res, next);
  }
}

/**
 * POST /tokens/purchase/google
 *
 * Body: { purchase_token: string, package_id: string }
 * Success 200: { success: true, tokens_added: number, new_balance: object }
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function purchaseGoogle(req, res, next) {
  try {
    const { purchase_token, package_id } = req.body;

    if (!purchase_token || !package_id) {
      return res.status(400).json({ error: 'purchase_token and package_id are required' });
    }

    const { iapService } = req.app.locals;
    const result = await iapService.verifyGoogleReceipt(req.user.id, purchase_token, package_id);

    return res.status(200).json(result);
  } catch (err) {
    return handleIAPError(err, res, next);
  }
}

/**
 * GET /tokens/packages
 *
 * Returns all active token packages. Requires premium plan.
 * Success 200: { packages: [...] }
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function getPackages(req, res, next) {
  try {
    const { db } = req.app.locals;

    // Plan check: only premium users can purchase packages
    const { rows: userRows } = await db.query(
      'SELECT plan FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userRows.length === 0 || userRows[0].plan !== 'premium') {
      return res.status(403).json({ error: 'Only premium users can purchase tokens' });
    }

    const { rows: packages } = await db.query(
      `SELECT id, name, token_amount, price_usd
         FROM token_packages
        WHERE is_active = true
        ORDER BY price_usd ASC`
    );

    return res.status(200).json({ packages });
  } catch (err) {
    logger.error('[IAPController] Unhandled error in GET /tokens/packages', err);
    next(err);
  }
}

/**
 * POST /tokens/purchase/revenuecat
 *
 * Called by the mobile app after RevenueCat confirms a consumable token purchase.
 * Backend re-verifies via RC REST API before crediting tokens.
 *
 * Body: { transaction_id, package_id, platform }
 * Success 200: { success: true, tokens_added: number, new_balance: object }
 */
async function purchaseRevenueCat(req, res, next) {
  try {
    const { transaction_id, package_id, platform } = req.body;

    if (!transaction_id || !package_id || !platform) {
      return res.status(400).json({
        error: 'transaction_id, package_id, and platform are required',
      });
    }

    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ error: "platform must be 'ios' or 'android'" });
    }

    const { iapService } = req.app.locals;
    const result = await iapService.verifyRevenueCatPurchase(
      req.user.id,
      transaction_id,
      package_id,
      platform
    );

    return res.status(200).json(result);
  } catch (err) {
    return handleIAPError(err, res, next);
  }
}

module.exports = { purchaseApple, purchaseGoogle, getPackages, purchaseRevenueCat };
