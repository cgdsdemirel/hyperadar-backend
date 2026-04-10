'use strict';

const { Router } = require('express');
const { loginLimiter } = require('../middleware/rateLimiter');
const { register, login } = require('../controllers/AuthController');

const router = Router();

// Both registration and login share the strict rate limiter (5 req / 15 min)
router.post('/register', loginLimiter, register);
router.post('/login',    loginLimiter, login);

module.exports = router;
