'use strict';

const { Router } = require('express');
const { authenticate }   = require('../middleware/auth');
const { me, updatePlan } = require('../controllers/UserController');

const router = Router();

// All /user routes require a valid JWT
router.get('/me',     authenticate, me);
router.patch('/plan', authenticate, updatePlan);

module.exports = router;
