'use strict';

/**
 * Minimal structured logger for HypeRadar.
 *
 * Format: [2026-04-10T08:00:00.000Z] [INFO]  message
 *         [2026-04-10T08:00:00.000Z] [ERROR] message
 *                                             Error: something went wrong
 *                                                 at ...
 *
 * Using a thin wrapper (rather than a full logger lib) keeps the dependency
 * footprint small. Swap for Winston/Pino in production as needed.
 */

function timestamp() {
  return new Date().toISOString();
}

function info(msg) {
  process.stdout.write(`[${timestamp()}] [INFO]  ${msg}\n`);
}

function error(msg, err) {
  process.stderr.write(`[${timestamp()}] [ERROR] ${msg}\n`);
  if (err) {
    // Always include the full stack so pipeline failures are diagnosable
    process.stderr.write(`${err.stack || String(err)}\n`);
  }
}

function warn(msg) {
  process.stderr.write(`[${timestamp()}] [WARN]  ${msg}\n`);
}

module.exports = { info, error, warn };
