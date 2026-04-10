'use strict';

const { Router } = require('express');
const { authenticate }       = require('../middleware/auth');
const { validateQueryInput } = require('../middleware/validateInput');
const { execute }            = require('../controllers/QueryController');

const router = Router();

/**
 * POST /query
 *
 * Middleware chain:
 *   1. authenticate     — verify JWT, populate req.user
 *   2. validateQueryInput — check regions/categories structure + allowed values
 *   3. execute          — QueryService orchestration + response
 */
router.post('/', authenticate, validateQueryInput, execute);

// TODO (Phase 5): GET /query/history — paginated query history for the user

module.exports = router;
