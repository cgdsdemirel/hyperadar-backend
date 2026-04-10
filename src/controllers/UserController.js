'use strict';

const { NotFoundError, ValidationError } = require('../utils/errors');

/**
 * UserController — user profile and token balance endpoints.
 *
 * All routes here require the `authenticate` middleware to have already
 * populated req.user.id.
 */

/**
 * GET /user/me
 *
 * Fetches the authenticated user's profile and current token balance.
 *
 * Success 200:
 * {
 *   user:   { id, email, plan, created_at },
 *   tokens: { monthly, purchased, reset_date }
 * }
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function me(req, res, next) {
  try {
    const userId = req.user.id;
    const { db } = req.app.locals;

    // Fetch user profile (exclude password_hash)
    const { rows: userRows } = await db.query(
      `SELECT id, email, plan, created_at
         FROM users
        WHERE id = $1`,
      [userId]
    );

    if (userRows.length === 0) throw new NotFoundError('User');
    const user = userRows[0];

    // Fetch token balance
    const { rows: balanceRows } = await db.query(
      `SELECT monthly_tokens, purchased_tokens, reset_date
         FROM token_balances
        WHERE user_id = $1`,
      [userId]
    );

    // A balance row is created on register; missing row is an inconsistency worth surfacing
    const balance = balanceRows[0] || { monthly_tokens: 0, purchased_tokens: 0, reset_date: null };

    return res.status(200).json({
      user,
      tokens: {
        monthly:    balance.monthly_tokens,
        purchased:  balance.purchased_tokens,
        reset_date: balance.reset_date,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /user/plan ─────────────────────────────────────────────────────────

/**
 * Update the authenticated user's plan.
 *
 * Called by the mobile app after RevenueCat confirms a subscription event.
 * RevenueCat is the source of truth for entitlements — this endpoint syncs DB.
 *
 * Body: { plan: 'free' | 'premium' }
 *
 * Upgrade to premium → sets monthly_tokens = 4000, reset_date = 1st of next month.
 * Downgrade to free  → tokens are NOT touched (let them be consumed naturally).
 *
 * Success 200: { user }
 */
async function updatePlan(req, res, next) {
  const client = await req.app.locals.db.connect();
  try {
    const userId = req.user.id;
    const { plan } = req.body;

    if (plan !== 'free' && plan !== 'premium') {
      throw new ValidationError("plan must be 'free' or 'premium'");
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE users
          SET plan = $1
        WHERE id   = $2
        RETURNING id, email, plan, created_at`,
      [plan, userId]
    );

    if (rows.length === 0) throw new NotFoundError('User');

    if (plan === 'premium') {
      const now       = new Date();
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      await client.query(
        `UPDATE token_balances
            SET monthly_tokens = 4000,
                reset_date     = $1
          WHERE user_id = $2`,
        [nextMonth, userId]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ user: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { me, updatePlan };
