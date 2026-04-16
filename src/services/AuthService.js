'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  DuplicateEmailError,
  InvalidCredentialsError,
  InvalidTokenError,
} = require('../utils/errors');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '15m';
const REFRESH_TTL = 30; // days

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
    const refreshToken = await this.generateRefreshToken(user.id);
    return { user: this._sanitize(user), token, refreshToken };
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
    const refreshToken = await this.generateRefreshToken(user.id);
    return { user: this._sanitize(user), token, refreshToken };
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

  /**
   * Generate a refresh token, persist its hash, and return the raw token.
   * @param {string} userId
   * @returns {Promise<string>} raw (unhashed) refresh token
   */
  async generateRefreshToken(userId) {
    const token = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL * 24 * 60 * 60 * 1000);

    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt]
    );

    return token;
  }

  /**
   * Exchange a valid refresh token for a new access token + rotated refresh token.
   * @param {string} refreshToken  raw token from client
   * @returns {Promise<{ accessToken: string, refreshToken: string, user: object }>}
   */
  async refreshAccessToken(refreshToken) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const { rows } = await this.db.query(
      `SELECT rt.id, rt.user_id, u.id AS uid, u.email, u.plan
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          AND rt.revoked = false
          AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    if (rows.length === 0) {
      throw new InvalidTokenError('Invalid or expired refresh token');
    }

    const row = rows[0];
    const user = { id: row.uid, email: row.email, plan: row.plan };

    // Revoke old token before issuing new ones (rotation)
    await this.db.query(
      'UPDATE refresh_tokens SET revoked = true WHERE id = $1',
      [row.id]
    );

    const accessToken = this.generateToken(user.id);
    const newRefreshToken = await this.generateRefreshToken(user.id);

    return { accessToken, refreshToken: newRefreshToken, user };
  }

  /**
   * Revoke all active refresh tokens for a user (logout).
   * @param {string} userId
   */
  async revokeAllRefreshTokens(userId) {
    await this.db.query(
      'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false',
      [userId]
    );
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
