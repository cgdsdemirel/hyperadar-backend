'use strict';

const cron   = require('node-cron');
const logger = require('../utils/logger');
const pool   = require('../config/db');
const { runPipeline } = require('./pipeline');

/**
 * Pipeline schedule: 08:00 UTC every day.
 */
const SCHEDULE  = '0 8 * * *';

/**
 * Keepalive heartbeat: every 5 minutes.
 * Creates a log entry in Railway so ops can see the process is alive.
 */
const HEARTBEAT = '*/5 * * * *';

/**
 * On startup: find any pipeline_logs rows stuck in 'running' state
 * for more than 2 hours and mark them as failed.
 * This handles crash/restart scenarios.
 */
async function markStuckRunsAsFailed() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE pipeline_logs
          SET status = 'failed',
              completed_at = now(),
              error_message = 'Process restarted before run completed (stuck run detected)'
        WHERE status = 'running'
          AND started_at < now() - INTERVAL '2 hours'`
    );
    if (rowCount > 0) {
      logger.warn(`[Cron] Marked ${rowCount} stuck pipeline run(s) as failed on startup`);
    }
  } catch (err) {
    logger.error('[Cron] Failed to mark stuck runs on startup', err);
  }
}

function startCron() {
  if (!cron.validate(SCHEDULE)) {
    logger.error(`[Cron] Invalid pipeline cron expression: "${SCHEDULE}"`);
    return;
  }

  // Detect and clean up stuck runs from a previous crash
  markStuckRunsAsFailed();

  // ── Pipeline schedule ─────────────────────────────────────────────────────
  cron.schedule(
    SCHEDULE,
    async () => {
      logger.info(`[Cron] Pipeline triggered at ${new Date().toISOString()}`);
      try {
        await runPipeline(pool);
      } catch (err) {
        logger.error('[Cron] runPipeline threw unexpectedly', err);
      }
    },
    { timezone: 'UTC' }
  );

  logger.info(`[Cron] Pipeline scheduled — next run at 08:00 UTC (expression: "${SCHEDULE}")`);

  // ── Keepalive heartbeat ───────────────────────────────────────────────────
  cron.schedule(
    HEARTBEAT,
    () => {
      logger.info('[Cron] Heartbeat — cron job alive');
    },
    { timezone: 'UTC' }
  );

  logger.info('[Cron] Heartbeat scheduled — logging every 5 minutes');
}

module.exports = { startCron };
