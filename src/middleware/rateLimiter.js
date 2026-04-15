const rateLimit = require('express-rate-limit');

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress || 'unknown';
};

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  message: { error: 'Too many attempts. Please try again after 1 minute.' }
});

const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  message: { error: 'Query rate limit exceeded. Please wait.' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  message: { error: 'Admin rate limit exceeded.' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  skip: (req) => req.path === '/health',
  message: { error: 'Too many requests. Please try again later.' }
});

module.exports = { authLimiter, queryLimiter, adminLimiter, generalLimiter };
