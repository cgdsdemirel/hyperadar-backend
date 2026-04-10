'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {
  DuplicateEmailError,
  InvalidCredentialsError,
  InvalidTokenError,
} = require('../utils/errors');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '7d';

// Basic email regex — rejects obviously malformed addresses without external deps
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthService {
  /**
   * @param {import('pg').Pool} db
   * @param {string} jwtSecret
   */
  constructor(db, jwtSecret) {
    this.db = db;
    this.jwtSecret = jwtSecret;
  }

  // ─────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────

  /**
   * Register a new user.
   *
   * Steps:
   *   1. Validate email format
   *   2. Ensure email is not already taken
   *   3. Hash password (bcrypt, saltRounds: 12)
   *   4. Insert user row
   *   5. Create token_balances row (monthly: 0, purchased: 0)
   *   6. Return sanitised user + signed JWT
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ user: object, token: string }>}
   */
  async register(email, password) {
    // 1. Validate
    if (!email || !EMAIL_RE.test(email)) {
      const err = new Error('Invalid email address');
      err.statusCode = 400;
      throw err;
    }
    if (!password || password.length < 8) {
      const err = new Error('Password must be at least 8 characters');
      err.statusCode = 400;
      throw err;
    }

    // 2. Duplicate check
    const { rows: existing } = await this.db.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existing.length > 0) throw new DuplicateEmailError();

    // 3. Hash
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // 4 + 5. Insert user and balance atomically
    const client = await this.db.connect();
    let user;
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, plan, created_at`,
        [email.toLowerCase(), passwordHash]
      );
      user = rows[0];

      await client.query(
        `INSERT INTO token_balances (user_id, monthly_tokens, purchased_tokens)
         VALUES ($1, 0, 0)`,
        [user.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const token = this.generateToken(user.id);
    return { user: this._sanitize(user), token };
  }

  /**
   * Authenticate a user and return a signed JWT.
   *
   * Deliberately uses the same error (InvalidCredentialsError) for both
   * "user not found" and "wrong password" to avoid leaking which field failed.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ user: object, token: string }>}
   */
  async login(email, password) {
    if (!email || !password) throw new InvalidCredentialsError();

    const { rows } = await this.db.query(
      `SELECT id, email, plan, created_at, password_hash
         FROM users
        WHERE email = $1`,
      [email.toLowerCase()]
    );

    // Intentionally do not short-circuit before bcrypt to avoid timing attacks
    const user = rows[0] || null;
    const hashToCompare = user ? user.password_hash : '$2b$12$invalidhashpadding000000000000000000000000000000000000';

    const match = await bcrypt.compare(password, hashToCompare);
    if (!user || !match) throw new InvalidCredentialsError();

    const token = this.generateToken(user.id);
    return { user: this._sanitize(user), token };
  }

  /**
   * Sign a JWT containing the userId.
   * @param {string} userId
   * @returns {string}
   */
  generateToken(userId) {
    return jwt.sign({ sub: userId }, this.jwtSecret, { expiresIn: TOKEN_TTL });
  }

  /**
   * Verify and decode a JWT.
   * @param {string} token
   * @returns {object} Decoded payload
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (err) {
      throw new InvalidTokenError(
        err.name === 'TokenExpiredError' ? 'Token has expired' : 'Invalid token'
      );
    }
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────

  /** Strip sensitive fields before returning to client */
  _sanitize(user) {
    const { password_hash, ...safe } = user; // eslint-disable-line no-unused-vars
    return safe;
  }
}

module.exports = { AuthService };
