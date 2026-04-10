'use strict';

/**
 * Environment variable validation.
 * Call validateEnv() once at startup before anything else.
 *
 * REQUIRED variables cause a hard crash with a clear message.
 * OPTIONAL variables emit a warning and disable the related feature.
 */

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
];

const OPTIONAL = [
  { key: 'YOUTUBE_API_KEY',            feature: 'YouTube fetcher' },
  { key: 'REDDIT_CLIENT_ID',           feature: 'Reddit fetcher' },
  { key: 'REDDIT_CLIENT_SECRET',       feature: 'Reddit fetcher' },
  { key: 'PRODUCT_HUNT_API_KEY',       feature: 'Product Hunt fetcher' },
  { key: 'APPLE_SHARED_SECRET',        feature: 'Apple IAP verification' },
  { key: 'GOOGLE_SERVICE_ACCOUNT_JSON',feature: 'Google IAP verification' },
  { key: 'REVENUECAT_SECRET_KEY',      feature: 'RevenueCat server-side verification' },
  { key: 'SENTRY_DSN',                 feature: 'Sentry error tracking' },
  { key: 'ALLOWED_ORIGINS',            feature: 'CORS whitelist (defaults to localhost only)' },
];

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    const list = missing.map((k) => `  - ${k}`).join('\n');
    throw new Error(
      `[ENV] Missing required environment variables:\n${list}\n\nSet these in your .env file or Railway dashboard and restart.`
    );
  }

  for (const { key, feature } of OPTIONAL) {
    if (!process.env[key]) {
      // Use console.warn here — logger may not be initialized yet
      console.warn(`[ENV] Warning: ${key} is not set — ${feature} will be disabled.`);
    }
  }
}

module.exports = { validateEnv };
