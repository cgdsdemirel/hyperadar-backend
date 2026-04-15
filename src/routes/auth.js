'use strict';

const { Router } = require('express');
const { authLimiter } = require('../middleware/rateLimiter');
const { register, login } = require('../controllers/AuthController');

const router = Router();

// Both registration and login share the strict rate limiter (5 req / 15 min)
router.post('/register', authLimiter, register);
router.post('/login',    authLimiter, login);

module.exports = router;
