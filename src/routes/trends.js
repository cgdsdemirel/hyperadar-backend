'use strict';

/**
 * Trend routes.
 *
 * GET /trends/history              — authenticated, returns recent trends by filter
 * GET /trends/:trend_id            — public, returns a single trend by UUID
 * GET /trends/:trend_id/score-history — public, returns score snapshots
 */

const { Router }     = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();

/**
 * GET /trends/history?category=X&region=Y&days=7
 * Auth required. Returns up to 50 trends matching category + region
 * created within the last `days` days, ordered newest-first.
 */
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const { category, region, days } = req.query;

    if (!category || !region) {
      return res.status(400).json({ error: 'category and region are required' });
    }

    const daysNum = Math.min(90, Math.max(1, parseInt(days, 10) || 7));

    const { rows } = await req.app.locals.db.query(
      `SELECT id, title, description, category, region, lang,
              score, monetization_hint, source, created_at
         FROM trends
        WHERE category   = $1
          AND region     = $2
          AND created_at >= now() - ($3 || ' days')::interval
        ORDER BY created_at DESC, score DESC
        LIMIT 50`,
      [category, region, daysNum]
    );

    res.json({ trends: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:trend_id', async (req, res, next) => {
  try {
    const trend = await req.app.locals.trendService.getTrendById(req.params.trend_id);
    if (!trend) return res.status(404).json({ error: 'Trend bulunamadı' });
    res.json({ trend });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /trends/:trend_id/score-history
 * Returns the last 7 score snapshots for a trend, oldest-first.
 * Public — no authentication required.
 */
router.get('/:trend_id/score-history', async (req, res, next) => {
  try {
    const history = await req.app.locals.trendService.getScoreHistory(req.params.trend_id);
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
