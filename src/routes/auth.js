'use strict';

const { Router } = require('express');
const { register, login, refresh, logout } = require('../controllers/AuthController');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authenticate, logout);

module.exports = router;
