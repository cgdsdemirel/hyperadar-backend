'use strict';

// ─── Node.js 18 polyfill — undici requires File to be a global ───────────────
// Remove once Railway defaults to Node 20+
const { File } = require('buffer');
global.File = File;

// ─── Startup confirmation — appears immediately in Railway logs ───────────────
console.log('[boot] HypeRadar process starting...');
console.log('[boot] Node version:', process.version);
console.log('[boot] NODE_ENV:', process.env.NODE_ENV || 'development');

// ─── Catch anything that crashes before we set up proper error handling ───────
process.on('uncaughtException', (err) => {
  console.error('[boot] UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[boot] UNHANDLED REJECTION:', reason);
  process.exit(1);
});

// ─── Load env ─────────────────────────────────────────────────────────────────
require('dotenv').config();

// ─── Sentry (no-op if SENTRY_DSN is not set) ─────────────────────────────────
const Sentry = require('@sentry/node');

Sentry.init({
  dsn:              process.env.SENTRY_DSN,
  environment:      process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
});

// ─── Validate env vars — warn but do NOT crash so /health always responds ─────
const { validateEnv } = require('./src/config/env');
try {
  validateEnv();
  console.log('[boot] Environment validation passed');
} catch (err) {
  console.error('[boot] Environment validation failed:', err.message);
  console.error('[boot] Server will start but some features will not work until env vars are set');
}

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

console.log('[boot] All modules loaded');

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Trust Railway proxy so rate limiting uses real client IPs
app.set('trust proxy', 1);

// ── Health check — registered FIRST, before rate limiter, before everything ───
// Railway probes this endpoint to determine if the service is healthy.
// It must never be blocked by rate limiting, auth, or any other middleware.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

console.log('[boot] /health endpoint registered');

// ─── CORS whitelist ───────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3001', 'http://localhost:3000'];

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`CORS: Origin "${origin}" not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(helmet());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
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

// Global rate limiter (applied after /health so healthchecks are never rate-limited)
app.use(globalLimiter);

// ─── Service instances ────────────────────────────────────────────────────────

const authService  = new AuthService(pool, process.env.JWT_SECRET);
const tokenService = new TokenService(pool);
const trendService = new TrendService(pool);
const queryService = new QueryService(pool, tokenService, trendService);
const adService    = new AdService(pool);
const iapService   = new IAPService(pool);

// Inject into app.locals — accessible as req.app.locals.* in controllers
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
app.use('/trends', require('./src/routes/trends'));   // public — no auth
app.use('/ads',    require('./src/routes/ads'));
app.use('/tokens', require('./src/routes/iap'));
app.use('/admin',  require('./src/routes/admin'));

// ─── Error handlers ───────────────────────────────────────────────────────────

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

console.log(`[boot] Starting server on port ${PORT}...`);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] Server listening on 0.0.0.0:${PORT} ✓`);
  logger.info(`HypeRadar backend listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  startCron();
});

server.on('error', (err) => {
  console.error('[boot] Server failed to start:', err.message);
  process.exit(1);
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

  setTimeout(() => {
    logger.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
