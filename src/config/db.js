'use strict';

const { Pool } = require('pg');
const logger   = require('../utils/logger');

/**
 * Production-ready connection pool.
 *
 * SSL enabled with rejectUnauthorized: false for all environments
 * (required for Supabase pooler, including Railway deployments).
 * Use the Supabase Transaction Mode pooler URL (port 6543), never direct.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    10,   // max connections in pool
  idleTimeoutMillis:   30000,   // close idle connections after 30s
  connectionTimeoutMillis: 2000, // fail fast if pool is exhausted
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error('[DB] Unexpected database pool error', err);
});

pool.on('connect', () => {
  logger.info('[DB] New client connected to pool');
});

module.exports = pool;
