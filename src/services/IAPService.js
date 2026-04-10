'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');
const {
  IAPValidationError,
  DuplicateReceiptError,
  NotFoundError,
  PlanLimitError,
} = require('../utils/errors');

const APPLE_PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL    = 'https://sandbox.itunes.apple.com/verifyReceipt';

/** Apple status code indicating the receipt is from the sandbox environment */
const APPLE_STATUS_SANDBOX    = 21007;
/** Apple status code indicating a valid receipt */
const APPLE_STATUS_OK         = 0;

/** Google Play purchase states */
const GOOGLE_PURCHASE_STATE_PURCHASED = 0;

class IAPService {
  /**
   * @param {import('pg').Pool} db
   */
  constructor(db) {
    this.db = db;
  }

  // ─────────────────────────────────────────
  // Apple
  // ─────────────────────────────────────────

  /**
   * Validate an Apple App Store receipt and credit tokens to the user.
   *
   * Flow:
   *   1. Validate receipt with Apple (auto-retry for sandbox receipts)
   *   2. Guard against duplicate transaction_id
   *   3. Resolve token package
   *   4. Credit tokens + record receipt atomically
   *   5. Return updated balance
   *
   * @param {string} userId
   * @param {string} receiptData - Base64 receipt from StoreKit
   * @param {string} packageId   - token_packages.id
   * @returns {Promise<{ success: true, tokens_added: number, new_balance: object }>}
   */
  async verifyAppleReceipt(userId, receiptData, packageId) {
    await this._assertPremium(userId);

    // 1. Validate with Apple
    const receiptInfo = await this._callAppleVerify(receiptData);
    const transactionId = this._extractAppleTransactionId(receiptInfo);

    if (!transactionId) {
      throw new IAPValidationError('Could not extract transaction ID from Apple receipt');
    }

    // 2. Duplicate check
    await this._assertReceiptNotUsed(transactionId);

    // 3. Resolve package
    const pkg = await this._getPackage(packageId);

    // 4. Credit tokens + record receipt atomically
    const balance = await this._creditTokensAndRecord({
      userId,
      platform:      'apple',
      transactionId,
      packageId,
      tokensAdded:   pkg.token_amount,
    });

    logger.info(
      `[IAPService] Apple purchase — user=${userId} pkg=${packageId} ` +
      `tokens_added=${pkg.token_amount} tx=${transactionId}`
    );

    return {
      success:      true,
      tokens_added: pkg.token_amount,
      new_balance:  balance,
    };
  }

  // ─────────────────────────────────────────
  // Google
  // ─────────────────────────────────────────

  /**
   * Validate a Google Play purchase token and credit tokens to the user.
   *
   * Flow:
   *   1. Get access token from Google service account (JWT auth)
   *   2. Fetch purchase details from Play Developer API
   *   3. Acknowledge the purchase (required within 3 days or Google refunds)
   *   4. Guard against duplicate purchaseToken
   *   5. Resolve token package
   *   6. Credit tokens + record receipt atomically
   *   7. Return updated balance
   *
   * @param {string} userId
   * @param {string} purchaseToken - Token from Google Play Billing
   * @param {string} packageId     - token_packages.id (maps to Google productId)
   * @returns {Promise<{ success: true, tokens_added: number, new_balance: object }>}
   */
  async verifyGoogleReceipt(userId, purchaseToken, packageId) {
    await this._assertPremium(userId);

    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
    if (!packageName) throw new IAPValidationError('GOOGLE_PLAY_PACKAGE_NAME is not configured');

    // 1. Authenticate with Google
    const accessToken = await this._getGoogleAccessToken();

    // 2. Fetch purchase details
    const purchaseUrl =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications` +
      `/${packageName}/purchases/products/${packageId}/tokens/${purchaseToken}`;

    let purchase;
    try {
      const { data } = await axios.get(purchaseUrl, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      purchase = data;
    } catch (err) {
      logger.error('[IAPService] Google Play purchase lookup failed', err);
      throw new IAPValidationError('Could not verify purchase with Google Play');
    }

    // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending
    if (purchase.purchaseState !== GOOGLE_PURCHASE_STATE_PURCHASED) {
      throw new IAPValidationError(
        `Google purchase not in purchased state (state=${purchase.purchaseState})`
      );
    }

    // 3. Acknowledge (must be done within 3 days or Google auto-refunds)
    await this._acknowledgeGooglePurchase(accessToken, packageName, packageId, purchaseToken);

    // 4. Duplicate check (use purchaseToken as the transaction_id for Google)
    await this._assertReceiptNotUsed(purchaseToken);

    // 5. Resolve package
    const pkg = await this._getPackage(packageId);

    // 6. Credit tokens + record
    const balance = await this._creditTokensAndRecord({
      userId,
      platform:      'google',
      transactionId: purchaseToken,
      packageId,
      tokensAdded:   pkg.token_amount,
    });

    logger.info(
      `[IAPService] Google purchase — user=${userId} pkg=${packageId} ` +
      `tokens_added=${pkg.token_amount} token=${purchaseToken}`
    );

    return {
      success:      true,
      tokens_added: pkg.token_amount,
      new_balance:  balance,
    };
  }

  // ─────────────────────────────────────────
  // RevenueCat
  // ─────────────────────────────────────────

  /**
   * Token amounts by RevenueCat package identifier.
   * Must stay in sync with constants/iap.js on the mobile side.
   * Server owns this mapping — never trust client-provided amounts.
   */
  static RC_TOKEN_AMOUNTS = {
    hyperadar_tokens_1000: 1000,
    hyperadar_tokens_2500: 2500,
    hyperadar_tokens_6000: 6000,
  };

  /**
   * Verify a RevenueCat-confirmed token purchase via RC REST API and credit tokens.
   *
   * Flow:
   *   1. Look up RC_TOKEN_AMOUNTS[package_id] — reject unknown identifiers
   *   2. Call RC REST API to verify the transaction_id exists for this subscriber
   *   3. Guard against duplicate transaction_id
   *   4. Credit tokens + record receipt atomically
   *   5. Return updated balance
   *
   * @param {string} userId
   * @param {string} transactionId  - RevenueCat transaction identifier
   * @param {string} packageId      - RC package identifier (e.g. 'hyperadar_tokens_1000')
   * @param {string} platform       - 'ios' | 'android'
   * @returns {Promise<{ success: true, tokens_added: number, new_balance: object }>}
   */
  async verifyRevenueCatPurchase(userId, transactionId, packageId, platform) {
    await this._assertPremium(userId);

    // 1. Resolve token amount from server-side mapping (never trust client)
    const tokensAdded = IAPService.RC_TOKEN_AMOUNTS[packageId];
    if (!tokensAdded) {
      throw new IAPValidationError(`Unknown RevenueCat package identifier: ${packageId}`);
    }

    // 2. Verify with RevenueCat REST API
    await this._assertRevenueCatTransaction(userId, packageId, transactionId);

    // 3. Duplicate check
    await this._assertReceiptNotUsed(transactionId);

    // 4. Credit tokens + record receipt atomically
    const rcPlatform = platform === 'android' ? 'google' : 'apple';
    const balance    = await this._creditTokensAndRecord({
      userId,
      platform:    rcPlatform,
      transactionId,
      packageId,
      tokensAdded,
    });

    logger.info(
      `[IAPService] RevenueCat purchase — user=${userId} pkg=${packageId} ` +
      `tokens_added=${tokensAdded} tx=${transactionId}`
    );

    return { success: true, tokens_added: tokensAdded, new_balance: balance };
  }

  /**
   * Verify that a given transaction_id appears in the subscriber's non_subscriptions
   * by calling the RevenueCat REST API.
   *
   * Throws IAPValidationError if the transaction cannot be confirmed.
   */
  async _assertRevenueCatTransaction(userId, packageId, transactionId) {
    const secretKey = process.env.REVENUECAT_SECRET_KEY;
    if (!secretKey) {
      // If RC secret is not configured, skip remote verification (dev fallback)
      logger.warn('[IAPService] REVENUECAT_SECRET_KEY not set — skipping RC verification');
      return;
    }

    let subscriber;
    try {
      const { data } = await axios.get(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
        {
          timeout: 15_000,
          headers: {
            Authorization:  `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      subscriber = data.subscriber;
    } catch (err) {
      logger.error('[IAPService] RevenueCat subscriber lookup failed', err);
      throw new IAPValidationError('Could not verify purchase with RevenueCat');
    }

    // nonSubscriptions is keyed by product identifier, value is array of transactions
    const transactions = subscriber?.non_subscriptions?.[packageId];
    if (!Array.isArray(transactions) || transactions.length === 0) {
      throw new IAPValidationError(`No RevenueCat transactions found for package ${packageId}`);
    }

    const found = transactions.some(
      (t) => t.id === transactionId || t.store_transaction_id === transactionId
    );

    if (!found) {
      throw new IAPValidationError(
        `Transaction ${transactionId} not found in RevenueCat subscriber record`
      );
    }
  }

  // ─────────────────────────────────────────
  // Private — Apple helpers
  // ─────────────────────────────────────────

  /**
   * Call Apple's receipt verification endpoint.
   * Auto-retries with the sandbox URL if Apple returns status 21007.
   */
  async _callAppleVerify(receiptData) {
    const body = {
      'receipt-data': receiptData,
      password:       process.env.APPLE_SHARED_SECRET,
    };

    const tryUrl = async (url) => {
      const { data } = await axios.post(url, body, { timeout: 15_000 });
      return data;
    };

    let response;
    try {
      response = await tryUrl(APPLE_PRODUCTION_URL);
    } catch (err) {
      logger.error('[IAPService] Apple production verify request failed', err);
      throw new IAPValidationError('Could not reach Apple receipt validation server');
    }

    // 21007 means this is a sandbox receipt — retry with sandbox endpoint
    if (response.status === APPLE_STATUS_SANDBOX) {
      logger.info('[IAPService] Apple returned 21007 — retrying with sandbox URL');
      try {
        response = await tryUrl(APPLE_SANDBOX_URL);
      } catch (err) {
        logger.error('[IAPService] Apple sandbox verify request failed', err);
        throw new IAPValidationError('Could not reach Apple sandbox validation server');
      }
    }

    if (response.status !== APPLE_STATUS_OK) {
      throw new IAPValidationError(`Apple receipt validation failed (status=${response.status})`);
    }

    return response;
  }

  /**
   * Extract the transaction_id from an Apple receipt validation response.
   * Checks latest_receipt_info first, falls back to receipt.in_app.
   */
  _extractAppleTransactionId(receiptResponse) {
    const latestInfo = receiptResponse.latest_receipt_info;
    if (Array.isArray(latestInfo) && latestInfo.length > 0) {
      return latestInfo[0].transaction_id || null;
    }
    const inApp = receiptResponse.receipt?.in_app;
    if (Array.isArray(inApp) && inApp.length > 0) {
      return inApp[0].transaction_id || null;
    }
    return null;
  }

  // ─────────────────────────────────────────
  // Private — Google helpers
  // ─────────────────────────────────────────

  /**
   * Obtain a short-lived OAuth2 access token from a Google service account.
   * Parses GOOGLE_SERVICE_ACCOUNT_JSON from env.
   */
  async _getGoogleAccessToken() {
    const { GoogleAuth } = require('google-auth-library');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    } catch {
      throw new IAPValidationError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }

    if (!credentials.client_email) {
      throw new IAPValidationError('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email');
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
  }

  /** POST :acknowledge to Google Play to confirm the purchase was granted. */
  async _acknowledgeGooglePurchase(accessToken, packageName, productId, purchaseToken) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications` +
      `/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}:acknowledge`;

    try {
      await axios.post(url, {}, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      // Log but do not abort — the purchase is valid; acknowledge can be retried.
      // Google gives 3 days before it auto-refunds.
      logger.error(
        `[IAPService] Google acknowledge failed for token=${purchaseToken} — must retry`,
        err
      );
    }
  }

  // ─────────────────────────────────────────
  // Private — shared helpers
  // ─────────────────────────────────────────

  /** Throw PlanLimitError if the user is not premium. */
  async _assertPremium(userId) {
    const { rows } = await this.db.query(
      'SELECT plan FROM users WHERE id = $1',
      [userId]
    );
    if (rows.length === 0)      throw new NotFoundError('User');
    if (rows[0].plan !== 'premium') {
      throw new PlanLimitError('Only premium users can purchase tokens');
    }
  }

  /** Throw DuplicateReceiptError if the transaction_id is already in processed_receipts. */
  async _assertReceiptNotUsed(transactionId) {
    const { rows } = await this.db.query(
      'SELECT id FROM processed_receipts WHERE transaction_id = $1',
      [transactionId]
    );
    if (rows.length > 0) throw new DuplicateReceiptError();
  }

  /**
   * Fetch an active token package by its ID.
   * @returns {{ id, name, token_amount, price_usd }}
   */
  async _getPackage(packageId) {
    const { rows } = await this.db.query(
      'SELECT id, name, token_amount, price_usd FROM token_packages WHERE id = $1 AND is_active = true',
      [packageId]
    );
    if (rows.length === 0) throw new NotFoundError('Token package');
    return rows[0];
  }

  /**
   * Atomically:
   *   1. Increment purchased_tokens in token_balances
   *   2. Insert a processed_receipts row (UNIQUE constraint prevents double-spend)
   *
   * Uses a transaction so both writes succeed or neither does.
   *
   * @returns {{ monthly: number, purchased: number }}
   */
  async _creditTokensAndRecord({ userId, platform, transactionId, packageId, tokensAdded }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Credit tokens
      const { rows: balRows } = await client.query(
        `UPDATE token_balances
            SET purchased_tokens = purchased_tokens + $1
          WHERE user_id = $2
          RETURNING monthly_tokens, purchased_tokens`,
        [tokensAdded, userId]
      );

      if (balRows.length === 0) {
        throw new Error(`token_balances row missing for user ${userId}`);
      }

      // Record receipt — UNIQUE constraint on transaction_id is the final safety net
      await client.query(
        `INSERT INTO processed_receipts
           (user_id, platform, transaction_id, package_id, tokens_added)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, platform, transactionId, packageId, tokensAdded]
      );

      await client.query('COMMIT');

      return {
        monthly:   balRows[0].monthly_tokens,
        purchased: balRows[0].purchased_tokens,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      // Re-map unique violation from the DB into our typed error
      if (err.code === '23505' && err.constraint === 'processed_receipts_transaction_id_key') {
        throw new DuplicateReceiptError();
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { IAPService };
