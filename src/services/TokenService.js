'use strict';

const { InsufficientTokensError } = require('../utils/errors');

// ─────────────────────────────────────────
// TokenService
// ─────────────────────────────────────────

class TokenService {
  /**
   * @param {Pool} db - pg Pool instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Calculate the token cost for a query based on selected categories.
   *
   * Rules:
   *   - 1 category  → 50 tokens
   *   - 2 categories → 60 tokens
   *   - More than 2  → throws Error (enforced at input validation too)
   *
   * @param {string[]} categories - Array of category strings selected by the user
   * @returns {number} Token cost
   */
  calculateQueryCost(categories) {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('At least one category is required');
    }

    if (categories.length === 1) return 50;
    if (categories.length === 2) return 60;

    throw new Error('A query may include at most 2 categories');
  }

  /**
   * Deduct tokens from a user's balance.
   *
   * Deduction order:
   *   1. monthly_tokens first (they expire on reset_date, so use them first)
   *   2. purchased_tokens for any remainder
   *   3. Throws InsufficientTokensError if combined balance is still insufficient
   *
   * The update is performed in a single atomic transaction.
   *
   * @param {string} userId - UUID of the user
   * @param {number} amount - Number of tokens to deduct
   * @returns {Promise<{ monthly_tokens: number, purchased_tokens: number }>} Updated balance
   */
  async deductTokens(userId, amount) {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Lock the row for this user to prevent race conditions
      const { rows } = await client.query(
        `SELECT monthly_tokens, purchased_tokens
           FROM token_balances
          WHERE user_id = $1
          FOR UPDATE`,
        [userId]
      );

      if (rows.length === 0) {
        throw new Error(`No token balance record found for user ${userId}`);
      }

      const { monthly_tokens, purchased_tokens } = rows[0];
      const total = monthly_tokens + purchased_tokens;

      if (total < amount) {
        throw new InsufficientTokensError(amount, total);
      }

      // Deduct from monthly first, then spill into purchased
      let newMonthly = monthly_tokens;
      let newPurchased = purchased_tokens;

      if (newMonthly >= amount) {
        newMonthly -= amount;
      } else {
        const remainder = amount - newMonthly;
        newMonthly = 0;
        newPurchased -= remainder;
      }

      await client.query(
        `UPDATE token_balances
            SET monthly_tokens   = $1,
                purchased_tokens = $2
          WHERE user_id = $3`,
        [newMonthly, newPurchased, userId]
      );

      await client.query('COMMIT');

      return { monthly_tokens: newMonthly, purchased_tokens: newPurchased };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { TokenService };
