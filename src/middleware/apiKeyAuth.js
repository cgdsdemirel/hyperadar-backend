'use strict';

const logger = require('../utils/logger');

/**
 * apiKeyAuth
 *
 * Validates the x-api-key request header against the api_keys table.
 * On success sets req.user = { id: <user_id> } — identical shape to the
 * JWT middleware — so downstream handlers work without modification.
 *
 * last_used_at is updated asynchronously (fire-and-forget) so the hot
 * path is never blocked by a second round-trip.
 */
async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = req.app.locals.db;

    const { rows } = await db.query(
      `SELECT id, user_id
         FROM api_keys
        WHERE key = $1 AND is_active = true`,
      [key]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Update last_used_at without blocking the request
    db.query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
      [rows[0].id]
    ).catch((err) => logger.warn('[ApiKeyAuth] last_used_at update failed', err));

    req.user = { id: rows[0].user_id };
    next();
  } catch (err) {
    logger.error('[ApiKeyAuth] DB error during key validation', err);
    next(err);
  }
}

/**
 * authenticateAny
 *
 * Accepts either a valid JWT (Authorization: Bearer <token>) or a valid
 * API key (x-api-key: <key>).  JWT is tried first; if the Bearer header
 * is absent or invalid the request falls through to API-key validation.
 *
 * Returns 401 only when neither credential is present or both fail.
 */
function authenticateAny(req, res, next) {
  // ── 1. Try JWT ──────────────────────────────────────────────────────────────
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    try {
      const { authService } = req.app.locals;
      const payload = authService.verifyToken(header.slice(7));
      req.user = { id: payload.sub };
      return next();
    } catch {
      // Invalid JWT — fall through to API key
    }
  }

  // ── 2. Try API key ──────────────────────────────────────────────────────────
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { apiKeyAuth, authenticateAny };
