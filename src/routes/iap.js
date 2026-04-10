'use strict';

const { Router }       = require('express');
const { authenticate } = require('../middleware/auth');
const {
  purchaseApple,
  purchaseGoogle,
  getPackages,
  purchaseRevenueCat,
} = require('../controllers/IAPController');

const router = Router();

/**
 * GET /tokens/packages
 * Returns active token packages. Premium only.
 */
router.get('/packages', authenticate, getPackages);

/**
 * POST /tokens/purchase/apple
 * Body: { receipt_data, package_id }
 * Premium only — receipt verified server-side with Apple.
 */
router.post('/purchase/apple', authenticate, purchaseApple);

/**
 * POST /tokens/purchase/google
 * Body: { purchase_token, package_id }
 * Premium only — purchase verified + acknowledged server-side with Google Play.
 */
router.post('/purchase/google', authenticate, purchaseGoogle);

/**
 * POST /tokens/purchase/revenuecat
 * Body: { transaction_id, package_id, platform }
 * Premium only — RC transaction verified server-side via RevenueCat REST API.
 */
router.post('/purchase/revenuecat', authenticate, purchaseRevenueCat);

module.exports = router;
