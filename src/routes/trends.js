'use strict';

/**
 * Public trend routes — no authentication required.
 *
 * GET /trends/:trend_id
 *   Returns a single trend by UUID.
 *   Used by deep links (hyperadar://trend/:id and https://hyperadar.app/trend/:id)
 *   so the app can show TrendDetail to any user, including unauthenticated ones.
 */

const { Router } = require('express');

const router = Router();

router.get('/:trend_id', async (req, res, next) => {
  try {
    const trend = await req.app.locals.trendService.getTrendById(req.params.trend_id);
    if (!trend) return res.status(404).json({ error: 'Trend bulunamadı' });
    res.json({ trend });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
