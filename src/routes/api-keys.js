'use strict';

/**
 * API key management routes (pro users only for key generation).
 *
 * POST   /api-keys        — create a new key (pro plan required)
 * GET    /api-keys        — list caller's keys (key value masked)
 * DELETE /api-keys/:id    — deactivate a key (soft delete)
 */

const { Router }     = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const logger           = require('../utils/logger');

const router = Router();

// ─── POST /api-keys ───────────────────────────────────────────────────────────

router.post('/', authenticate, async (req, res, next) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    // Pro-plan gate
    const { rows: userRows } = await db.query(
      'SELECT plan FROM users WHERE id = $1',
      [userId]
    );

    if (!userRows.length || userRows[0].plan !== 'pro') {
      return res.status(403).json({ error: 'Pro plan required to create API keys' });
    }

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Generate the key in Node so we can return it in the response.
    // The DB column also has a DEFAULT but we supply the value explicitly.
    const key = uuidv4();

    const { rows } = await db.query(
      `INSERT INTO api_keys (user_id, key, name)
       VALUES ($1, $2, $3)
       RETURNING id, key, name, is_active, created_at`,
      [userId, key, name.trim()]
    );

    logger.info(`[ApiKeys] Created key id=${rows[0].id} user=${userId} name="${name.trim()}"`);

    // The full key is only returned at creation time; the list endpoint masks it.
    return res.status(201).json({ api_key: rows[0] });
  } catch (err) {
    logger.error('[ApiKeys] POST / error', err);
    next(err);
  }
});

// ─── GET /api-keys ────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const { rows } = await db.query(
      `SELECT
          id,
          name,
          is_active,
          created_at,
          last_used_at,
          -- Show only the first 8 hex chars so the user can identify the key
          -- without exposing the full secret value
          CONCAT(LEFT(key::text, 8), '…') AS key_preview
         FROM api_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.status(200).json({ api_keys: rows });
  } catch (err) {
    logger.error('[ApiKeys] GET / error', err);
    next(err);
  }
});

// ─── DELETE /api-keys/:id ─────────────────────────────────────────────────────

router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const { rowCount } = await db.query(
      `UPDATE api_keys
          SET is_active = false
        WHERE id = $1
          AND user_id = $2
          AND is_active = true`,
      [req.params.id, req.user.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'API key not found or already inactive' });
    }

    logger.info(`[ApiKeys] Deactivated key id=${req.params.id} user=${req.user.id}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error('[ApiKeys] DELETE /:id error', err);
    next(err);
  }
});

module.exports = router;
