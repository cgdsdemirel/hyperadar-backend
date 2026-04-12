'use strict';

const { Router } = require('express');
const { authenticateAny }    = require('../middleware/apiKeyAuth');
const { validateQueryInput } = require('../middleware/validateInput');
const { execute }            = require('../controllers/QueryController');

const router = Router();

/**
 * POST /query
 *
 * Middleware chain:
 *   1. authenticateAny    — JWT (Authorization: Bearer) OR API key (x-api-key)
 *   2. validateQueryInput — check regions/categories structure + allowed values
 *   3. execute            — QueryService orchestration + response
 */
router.post('/', authenticateAny, validateQueryInput, execute);

// TODO (Phase 5): GET /query/history — paginated query history for the user

module.exports = router;
