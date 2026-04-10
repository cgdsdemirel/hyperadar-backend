'use strict';

const { Router }     = require('express');
const { authenticate } = require('../middleware/auth');
const { complete }     = require('../controllers/AdController');

const router = Router();

/**
 * POST /ads/complete
 * Body (optional): { query_id }
 *
 * Middleware: authenticate → complete
 */
router.post('/complete', authenticate, complete);

// TODO (Phase 6): GET /ads/status — return ads_watched_today for the user

module.exports = router;
