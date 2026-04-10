'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Global rate limiter: 30 requests per minute per IP.
 * Applied to all routes.
 * Note: app.set('trust proxy', 1) must be set in index.js so this uses
 * the real client IP from the X-Forwarded-For header behind Railway's proxy.
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again in a minute.',
  },
});

/**
 * Login-specific rate limiter: 5 requests per 15 minutes per IP.
 * Apply to POST /auth/login (and /auth/register if desired).
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Please try again in 15 minutes.',
  },
});

module.exports = { globalLimiter, loginLimiter };
