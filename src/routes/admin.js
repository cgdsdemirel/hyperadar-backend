'use strict';

const { Router } = require('express');
const jwt        = require('jsonwebtoken');
const logger     = require('../utils/logger');
const { runPipeline } = require('../pipeline/pipeline');

const router = Router();

// ─── Admin JWT middleware ─────────────────────────────────────────────────────

/**
 * Verify the admin JWT from the Authorization: Bearer header.
 * Admin tokens are issued by POST /admin/login and carry { role: 'admin' }.
 */
function adminAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * POST /admin/login
 * Body: { email, password }
 * Returns: { token, role: 'admin' }
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  if (
    email    !== process.env.ADMIN_EMAIL    ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    logger.warn(`[Admin] Failed login attempt for email="${email}"`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { role: 'admin', email },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  logger.info(`[Admin] Login successful for email="${email}"`);
  return res.status(200).json({ token, role: 'admin' });
});

/**
 * GET /admin/verify
 * Verifies the admin JWT is still valid.
 */
router.get('/verify', adminAuth, (req, res) => {
  res.status(200).json({ valid: true, admin: req.admin });
});

// ─── Dashboard stats ──────────────────────────────────────────────────────────

/**
 * GET /admin/stats
 * Returns all dashboard overview stats in a single response.
 */
router.get('/stats', adminAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const [
      totalUsers,
      planBreakdown,
      queriesToday,
      queriesMonth,
      tokensToday,
      tokensMonth,
      lastPipelineRun,
      totalTrends,
      dailyUsers,
      dailyQueries,
    ] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS count FROM users'),

      db.query(`
        SELECT plan, COUNT(*)::int AS count
          FROM users
         GROUP BY plan`),

      db.query(`
        SELECT COUNT(*)::int AS count FROM queries
         WHERE created_at >= CURRENT_DATE`),

      db.query(`
        SELECT COUNT(*)::int AS count FROM queries
         WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`),

      db.query(`
        SELECT COALESCE(SUM(token_spent), 0)::int AS total FROM queries
         WHERE created_at >= CURRENT_DATE`),

      db.query(`
        SELECT COALESCE(SUM(token_spent), 0)::int AS total FROM queries
         WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`),

      db.query(`
        SELECT MAX(started_at) AS last_run FROM pipeline_logs
         WHERE status = 'success'`),

      db.query('SELECT COUNT(*)::int AS count FROM trends'),

      db.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS count
          FROM users
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at)
         ORDER BY day`),

      db.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS count
          FROM queries
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at)
         ORDER BY day`),
    ]);

    const plans = {};
    for (const row of planBreakdown.rows) plans[row.plan] = row.count;

    return res.status(200).json({
      total_users:        totalUsers.rows[0].count,
      free_users:         plans.free    || 0,
      premium_users:      plans.premium || 0,
      queries_today:      queriesToday.rows[0].count,
      queries_this_month: queriesMonth.rows[0].count,
      tokens_today:       tokensToday.rows[0].total,
      tokens_this_month:  tokensMonth.rows[0].total,
      last_pipeline_run:  lastPipelineRun.rows[0]?.last_run || null,
      total_trends:       totalTrends.rows[0].count,
      daily_new_users:    dailyUsers.rows,
      daily_queries:      dailyQueries.rows,
    });
  } catch (err) {
    logger.error('[Admin] GET /stats error', err);
    next(err);
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * GET /admin/users
 * Query params: page (default 1), limit (default 20), search (email), plan (free|premium)
 */
router.get('/users', adminAuth, async (req, res, next) => {
  try {
    const db     = req.app.locals.db;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const plan   = req.query.plan   || null;

    const params = [limit, offset];
    let whereClause = 'WHERE 1=1';

    if (search) { params.push(search); whereClause += ` AND u.email ILIKE $${params.length}`; }
    if (plan)   { params.push(plan);   whereClause += ` AND u.plan = $${params.length}`; }

    const { rows: users } = await db.query(
      `SELECT
          u.id, u.email, u.plan, u.created_at,
          COALESCE(tb.monthly_tokens, 0)   AS monthly_tokens,
          COALESCE(tb.purchased_tokens, 0) AS purchased_tokens,
          COUNT(q.id)::int                 AS total_queries
         FROM users u
         LEFT JOIN token_balances tb ON tb.user_id = u.id
         LEFT JOIN queries q         ON q.user_id  = u.id
         ${whereClause}
         GROUP BY u.id, u.email, u.plan, u.created_at,
                  tb.monthly_tokens, tb.purchased_tokens
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
      params
    );

    // Total count for pagination
    const countParams = params.slice(2); // strip LIMIT/OFFSET
    const { rows: countRows } = await db.query(
      `SELECT COUNT(DISTINCT u.id)::int AS total
         FROM users u
         ${whereClause.replace('$3', `$${countParams.length > 0 ? 1 : 'X'}`)
           .replace('$4', `$${countParams.length > 1 ? 2 : 'X'}`)}`,
      countParams
    );

    return res.status(200).json({
      users,
      total:      countRows[0]?.total || 0,
      page,
      total_pages: Math.ceil((countRows[0]?.total || 0) / limit),
    });
  } catch (err) {
    logger.error('[Admin] GET /users error', err);
    next(err);
  }
});

/**
 * GET /admin/users/:id
 * Returns user detail with last 10 queries.
 */
router.get('/users/:id', adminAuth, async (req, res, next) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.params.id;

    const [userResult, balanceResult, queriesResult, receiptsResult] = await Promise.all([
      db.query(
        'SELECT id, email, plan, created_at FROM users WHERE id = $1',
        [userId]
      ),
      db.query(
        'SELECT monthly_tokens, purchased_tokens, reset_date FROM token_balances WHERE user_id = $1',
        [userId]
      ),
      db.query(
        `SELECT id, regions, categories, token_spent, created_at
           FROM queries
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 10`,
        [userId]
      ),
      db.query(
        `SELECT pr.platform, pr.tokens_added, pr.created_at, tp.name AS package_name
           FROM processed_receipts pr
           LEFT JOIN token_packages tp ON tp.id = pr.package_id
          WHERE pr.user_id = $1
          ORDER BY pr.created_at DESC
          LIMIT 10`,
        [userId]
      ),
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      user:     userResult.rows[0],
      balance:  balanceResult.rows[0] || null,
      queries:  queriesResult.rows,
      receipts: receiptsResult.rows,
    });
  } catch (err) {
    logger.error('[Admin] GET /users/:id error', err);
    next(err);
  }
});

/**
 * PATCH /admin/users/:id
 * Body: { plan }
 * Changes a user's plan. Valid values: free, premium, pro
 */
router.patch('/users/:id', adminAuth, async (req, res, next) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.params.id;
    const { plan } = req.body;

    const VALID_PLANS = ['free', 'premium', 'pro'];
    if (!plan || !VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` });
    }

    const { rows } = await db.query(
      `UPDATE users SET plan = $1 WHERE id = $2
       RETURNING id, email, plan, created_at`,
      [plan, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info(`[Admin] User ${userId} plan → "${plan}" by ${req.admin.email}`);
    return res.status(200).json({ user: rows[0] });
  } catch (err) {
    logger.error('[Admin] PATCH /users/:id error', err);
    next(err);
  }
});

// ─── Revenue ──────────────────────────────────────────────────────────────────

/**
 * GET /admin/revenue
 */
router.get('/revenue', adminAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const [revenueStats, recentTxns, dailyRevenue] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(tp.price_usd), 0)::numeric      AS revenue_this_month,
          COUNT(pr.id)::int                             AS transactions_this_month
          FROM processed_receipts pr
          JOIN token_packages tp ON tp.id = pr.package_id
         WHERE DATE_TRUNC('month', pr.created_at) = DATE_TRUNC('month', NOW())`),

      db.query(`
        SELECT
          u.email, pr.platform, tp.name AS package_name,
          pr.tokens_added, pr.created_at, tp.price_usd
          FROM processed_receipts pr
          JOIN users u          ON u.id  = pr.user_id
          JOIN token_packages tp ON tp.id = pr.package_id
         ORDER BY pr.created_at DESC
         LIMIT 50`),

      db.query(`
        SELECT
          DATE(pr.created_at) AS day,
          COALESCE(SUM(tp.price_usd), 0)::numeric AS revenue
          FROM processed_receipts pr
          JOIN token_packages tp ON tp.id = pr.package_id
         WHERE pr.created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(pr.created_at)
         ORDER BY day`),
    ]);

    // Average revenue per premium user
    const { rows: premiumCount } = await db.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE plan = 'premium'`
    );
    const totalRevenue = parseFloat(revenueStats.rows[0].revenue_this_month || 0);
    const premiumUsers = premiumCount.rows[0].count || 1;
    const avgRevenue   = (totalRevenue / premiumUsers).toFixed(2);

    return res.status(200).json({
      revenue_this_month:      revenueStats.rows[0].revenue_this_month,
      transactions_this_month: revenueStats.rows[0].transactions_this_month,
      avg_revenue_per_premium: avgRevenue,
      recent_transactions:     recentTxns.rows,
      daily_revenue:           dailyRevenue.rows,
    });
  } catch (err) {
    logger.error('[Admin] GET /revenue error', err);
    next(err);
  }
});

// ─── Token Usage ──────────────────────────────────────────────────────────────

/**
 * GET /admin/tokens
 */
router.get('/tokens', adminAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const [todayStats, monthStats, topUsers, categoryBreakdown, regionBreakdown, categoryChart] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(token_spent), 0)::int AS tokens_spent,
          COUNT(*)::int                       AS query_count
          FROM queries WHERE created_at >= CURRENT_DATE`),

      db.query(`
        SELECT
          COALESCE(SUM(token_spent), 0)::int AS tokens_spent,
          COUNT(*)::int                       AS query_count
          FROM queries
         WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`),

      db.query(`
        SELECT u.email, u.plan,
               COALESCE(SUM(q.token_spent), 0)::int AS tokens_this_month,
               COUNT(q.id)::int                      AS query_count
          FROM queries q
          JOIN users u ON u.id = q.user_id
         WHERE DATE_TRUNC('month', q.created_at) = DATE_TRUNC('month', NOW())
         GROUP BY u.id, u.email, u.plan
         ORDER BY tokens_this_month DESC
         LIMIT 20`),

      db.query(`
        SELECT UNNEST(categories) AS category, COUNT(*)::int AS count
          FROM queries
         GROUP BY UNNEST(categories)
         ORDER BY count DESC
         LIMIT 1`),

      db.query(`
        SELECT UNNEST(regions) AS region, COUNT(*)::int AS count
          FROM queries
         GROUP BY UNNEST(regions)
         ORDER BY count DESC
         LIMIT 1`),

      db.query(`
        SELECT
          DATE(created_at) AS day,
          UNNEST(categories) AS category,
          COALESCE(SUM(token_spent), 0)::int AS tokens
          FROM queries
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at), UNNEST(categories)
         ORDER BY day`),
    ]);

    const avgPerQuery = monthStats.rows[0].query_count > 0
      ? Math.round(monthStats.rows[0].tokens_spent / monthStats.rows[0].query_count)
      : 0;

    return res.status(200).json({
      tokens_today:          todayStats.rows[0].tokens_spent,
      tokens_this_month:     monthStats.rows[0].tokens_spent,
      avg_tokens_per_query:  avgPerQuery,
      most_popular_category: categoryBreakdown.rows[0]?.category || null,
      most_popular_region:   regionBreakdown.rows[0]?.region     || null,
      top_users:             topUsers.rows,
      category_chart:        categoryChart.rows,
    });
  } catch (err) {
    logger.error('[Admin] GET /tokens error', err);
    next(err);
  }
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * GET /admin/pipeline
 */
router.get('/pipeline', adminAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const [logs, totalTrends, recentTrends, byRegion, byCategory] = await Promise.all([
      db.query(`
        SELECT id, started_at, completed_at, status, trends_added, error_message
          FROM pipeline_logs
         ORDER BY started_at DESC
         LIMIT 20`),

      db.query('SELECT COUNT(*)::int AS count FROM trends'),

      db.query(`
        SELECT COUNT(*)::int AS count FROM trends
         WHERE created_at >= NOW() - INTERVAL '24 hours'`),

      db.query(`
        SELECT region, COUNT(*)::int AS count
          FROM trends
         GROUP BY region
         ORDER BY count DESC`),

      db.query(`
        SELECT category, COUNT(*)::int AS count
          FROM trends
         GROUP BY category
         ORDER BY count DESC`),
    ]);

    const lastSuccessful = logs.rows.find((r) => r.status === 'success');

    return res.status(200).json({
      last_run_time:     lastSuccessful?.started_at || null,
      total_trends:      totalTrends.rows[0].count,
      trends_last_24h:   recentTrends.rows[0].count,
      trends_by_region:  byRegion.rows,
      trends_by_category:byCategory.rows,
      logs:              logs.rows,
    });
  } catch (err) {
    logger.error('[Admin] GET /pipeline error', err);
    next(err);
  }
});

/**
 * GET /admin/pipeline/status
 * Returns the current pipeline health:
 *   - Last pipeline_log entry (any status)
 *   - Whether a run is currently in progress
 *   - Whether any run appears stuck (running > 2 hours)
 */
router.get('/pipeline/status', adminAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    const { rows } = await db.query(
      `SELECT id, started_at, completed_at, status, trends_added, error_message
         FROM pipeline_logs
        ORDER BY started_at DESC
        LIMIT 1`
    );

    const last = rows[0] || null;

    const isRunning = last?.status === 'running';
    const isStuck   = isRunning
      && last?.started_at
      && (Date.now() - new Date(last.started_at).getTime()) > 2 * 60 * 60 * 1000;

    return res.status(200).json({
      last_run:   last,
      is_running: isRunning,
      is_stuck:   isStuck,
      cron_schedule: '0 8,16 * * * (UTC)',
    });
  } catch (err) {
    logger.error('[Admin] GET /pipeline/status error', err);
    next(err);
  }
});

/**
 * POST /admin/pipeline/run
 * Triggers the pipeline asynchronously. Returns immediately.
 */
router.post('/pipeline/run', adminAuth, (req, res) => {
  const db = req.app.locals.db;

  // Fire-and-forget: admin gets immediate response, pipeline runs in background
  runPipeline(db).then((result) => {
    logger.info(`[Admin] Manual pipeline run finished — saved=${result.saved}`);
  }).catch((err) => {
    logger.error('[Admin] Manual pipeline run failed', err);
  });

  logger.info('[Admin] Manual pipeline run triggered');
  return res.status(200).json({ success: true, message: 'Pipeline started' });
});

module.exports = router;
