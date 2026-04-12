'use strict';

const { Router } = require('express');
const { authenticate }   = require('../middleware/auth');
const { me, updatePlan } = require('../controllers/UserController');
const logger             = require('../utils/logger');

const router = Router();

// ── Existing routes ───────────────────────────────────────────────────────────

// All /user routes require a valid JWT
router.get('/me',     authenticate, me);
router.patch('/plan', authenticate, updatePlan);

// ── Favorites ─────────────────────────────────────────────────────────────────

/**
 * POST /user/favorites
 * Body: { trend_id: UUID }
 * Add a trend to the authenticated user's favorites (idempotent).
 */
router.post('/favorites', authenticate, async (req, res, next) => {
  const { trend_id } = req.body;
  const userId       = req.user.id;

  if (!trend_id || typeof trend_id !== 'string') {
    return res.status(400).json({ error: 'trend_id is required' });
  }

  try {
    const db = req.app.locals.db;

    // ON CONFLICT DO NOTHING makes this idempotent
    await db.query(
      `INSERT INTO favorites (user_id, trend_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, trend_id) DO NOTHING`,
      [userId, trend_id]
    );

    logger.info(`[Favorites] user=${userId} favorited trend=${trend_id}`);
    return res.status(200).json({ success: true, favorited: true });
  } catch (err) {
    logger.error(`[Favorites] POST failed user=${userId} trend=${trend_id}`, err);
    next(err);
  }
});

/**
 * DELETE /user/favorites/:trend_id
 * Remove a trend from the authenticated user's favorites.
 */
router.delete('/favorites/:trend_id', authenticate, async (req, res, next) => {
  const { trend_id } = req.params;
  const userId       = req.user.id;

  try {
    const db = req.app.locals.db;

    await db.query(
      `DELETE FROM favorites WHERE user_id = $1 AND trend_id = $2`,
      [userId, trend_id]
    );

    logger.info(`[Favorites] user=${userId} unfavorited trend=${trend_id}`);
    return res.status(200).json({ success: true, favorited: false });
  } catch (err) {
    logger.error(`[Favorites] DELETE failed user=${userId} trend=${trend_id}`, err);
    next(err);
  }
});

/**
 * GET /user/favorites
 * Query params: page (default 1), limit (default 20, max 100)
 * Returns paginated list of favorited trend objects.
 */
router.get('/favorites', authenticate, async (req, res, next) => {
  const userId = req.user.id;
  const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    const db = req.app.locals.db;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT t.*,
                f.created_at AS favorited_at
           FROM favorites f
           JOIN trends t ON t.id = f.trend_id
          WHERE f.user_id = $1
          ORDER BY f.created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM favorites WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    logger.info(
      `[Favorites] GET user=${userId} page=${page} limit=${limit} total=${total}`
    );

    return res.status(200).json({
      favorites: dataResult.rows,
      total,
      page,
      limit,
    });
  } catch (err) {
    logger.error(`[Favorites] GET failed user=${userId}`, err);
    next(err);
  }
});

/**
 * GET /user/favorites/:trend_id/check
 * Check whether a specific trend is favorited by the authenticated user.
 */
router.get('/favorites/:trend_id/check', authenticate, async (req, res, next) => {
  const { trend_id } = req.params;
  const userId       = req.user.id;

  try {
    const db = req.app.locals.db;

    const { rows } = await db.query(
      `SELECT 1 FROM favorites WHERE user_id = $1 AND trend_id = $2 LIMIT 1`,
      [userId, trend_id]
    );

    return res.status(200).json({ favorited: rows.length > 0 });
  } catch (err) {
    logger.error(`[Favorites] CHECK failed user=${userId} trend=${trend_id}`, err);
    next(err);
  }
});

// ── Referral ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /user/referral/track
 * Body: { referrer_id: UUID, new_user_id: UUID }
 *
 * No authentication required — called immediately after registration,
 * before the client has a chance to attach a token.
 *
 * Idempotent: UNIQUE(referred_id) + ON CONFLICT DO NOTHING means a
 * user can only be referred once even if the request is retried.
 */
router.post('/referral/track', async (req, res, next) => {
  const { referrer_id, new_user_id } = req.body;

  if (!referrer_id || !new_user_id) {
    return res.status(400).json({ error: 'referrer_id and new_user_id are required' });
  }
  if (!UUID_RE.test(referrer_id) || !UUID_RE.test(new_user_id)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }
  if (referrer_id === new_user_id) {
    return res.status(400).json({ error: 'Self-referral is not allowed' });
  }

  try {
    const db = req.app.locals.db;

    await db.query(
      `INSERT INTO referrals (referrer_id, referred_id)
       VALUES ($1, $2)
       ON CONFLICT (referred_id) DO NOTHING`,
      [referrer_id, new_user_id]
    );

    logger.info(`[Referral] referrer=${referrer_id} referred=${new_user_id}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error(`[Referral] track failed referrer=${referrer_id} new_user=${new_user_id}`, err);
    next(err);
  }
});

module.exports = router;
