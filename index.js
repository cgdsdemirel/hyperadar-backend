'use strict';

// ─── Sentry must be initialized before any other imports ─────────────────────
require('dotenv').config();

const Sentry = require('@sentry/node');

Sentry.init({
  dsn:              process.env.SENTRY_DSN,   // no-op if undefined
  environment:      process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
});

// ─── Validate env vars — crashes fast with a clear message if missing ─────────
const { validateEnv } = require('./src/config/env');
validateEnv();

// ─── Core imports ─────────────────────────────────────────────────────────────
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const logger            = require('./src/utils/logger');
const pool              = require('./src/config/db');
const { globalLimiter } = require('./src/middleware/rateLimiter');
const { AuthService }   = require('./src/services/AuthService');
const { TokenService }  = require('./src/services/TokenService');
const { TrendService }  = require('./src/services/TrendService');
const { QueryService }  = require('./src/services/QueryService');
const { AdService }     = require('./src/services/AdService');
const { IAPService }    = require('./src/services/IAPService');
const { startCron }     = require('./src/pipeline/cron');

// ─── CORS whitelist ───────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3001', 'http://localhost:3000'];

const corsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`CORS: Origin "${origin}" not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── Service instances ────────────────────────────────────────────────────────

const authService  = new AuthService(pool, process.env.JWT_SECRET);
const tokenService = new TokenService(pool);
const trendService = new TrendService(pool);
const queryService = new QueryService(pool, tokenService, trendService);
const adService    = new AdService(pool);
const iapService   = new IAPService(pool);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Trust Railway / Render / Fly proxy so rate limiting uses real client IPs
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight

// Body parsing
app.use(express.json());

// Request logger — skip /health to keep logs clean
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Global rate limiter
app.use(globalLimiter);

// ─── Shared app locals — accessible as req.app.locals.* in controllers ────────

app.locals.db           = pool;
app.locals.authService  = authService;
app.locals.tokenService = tokenService;
app.locals.trendService = trendService;
app.locals.queryService = queryService;
app.locals.adService    = adService;
app.locals.iapService   = iapService;

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth',   require('./src/routes/auth'));
app.use('/user',   require('./src/routes/user'));
app.use('/query',  require('./src/routes/query'));
app.use('/ads',    require('./src/routes/ads'));
app.use('/tokens', require('./src/routes/iap'));
app.use('/admin',  require('./src/routes/admin'));

// Health check — no auth, no rate limit, no logs
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Error handlers ───────────────────────────────────────────────────────────

// Sentry must capture before our handler sends the response
Sentry.setupExpressErrorHandler(app);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    Sentry.captureException(err);
    logger.error('Unhandled error', err);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

const server = app.listen(PORT, () => {
  logger.info(`HypeRadar backend listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  startCron();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`[Shutdown] Received ${signal} — closing server…`);
  server.close(async () => {
    logger.info('[Shutdown] HTTP server closed');
    try {
      await pool.end();
      logger.info('[Shutdown] DB pool closed');
    } catch (err) {
      logger.error('[Shutdown] Error closing DB pool', err);
    }
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
