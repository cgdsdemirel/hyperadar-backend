'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const logger  = require('../utils/logger');
const { deduplicate }           = require('./deduplicator');
const { enrich }                = require('./enricher');
const { TrendService }          = require('../services/TrendService');
const { fetchYouTubeTrends }    = require('./fetchers/youtubeFetcher');
const { fetchGithubTrends }     = require('./fetchers/githubFetcher');
const { fetchProductHuntTrends }= require('./fetchers/productHuntFetcher');
const { fetchRssTrends }        = require('./fetchers/rssFetcher');
const { fetchRedditTrends }     = require('./fetchers/redditFetcher');

// ─── Config ───────────────────────────────────────────────────────────────────

const REGIONS    = ['Global', 'ABD', 'Turkiye', 'Almanya', 'Hindistan'];
const CATEGORIES = ['youtube', 'github', 'ai_tools', 'reddit'];

const MAX_ENRICH_PER_COMBO = 5;

// ─── Fetcher router ───────────────────────────────────────────────────────────

async function fetchForCombo(category, region) {
  switch (category) {
    case 'youtube':
      return fetchYouTubeTrends(region);

    case 'github':
      return fetchGithubTrends(region);

    case 'ai_tools': {
      if (region !== 'Global') return [];
      const [phItems, rssItems] = await Promise.all([
        fetchProductHuntTrends(),
        fetchRssTrends(),
      ]);
      return [...phItems, ...rssItems];
    }

    case 'reddit':
      return fetchRedditTrends(region);

    default:
      logger.warn(`[Pipeline] Unknown category: "${category}"`);
      return [];
  }
}

// ─── Pipeline log helpers ─────────────────────────────────────────────────────

async function createPipelineLog(pool) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO pipeline_logs (status, started_at)
       VALUES ('running', now())
       RETURNING id`
    );
    return rows[0].id;
  } catch (err) {
    logger.error('[Pipeline] Failed to create pipeline_logs row', err);
    return null;
  }
}

async function completePipelineLog(pool, logId, trendsAdded) {
  if (!logId) return;
  try {
    await pool.query(
      `UPDATE pipeline_logs
          SET status = 'success', completed_at = now(), trends_added = $1
        WHERE id = $2`,
      [trendsAdded, logId]
    );
  } catch (err) {
    logger.error('[Pipeline] Failed to update pipeline_logs (success)', err);
  }
}

async function failPipelineLog(pool, logId, errorMessage) {
  if (!logId) return;
  try {
    await pool.query(
      `UPDATE pipeline_logs
          SET status = 'failed', completed_at = now(), error_message = $1
        WHERE id = $2`,
      [errorMessage, logId]
    );
  } catch (err) {
    logger.error('[Pipeline] Failed to update pipeline_logs (failed)', err);
  }
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full HypeRadar data pipeline:
 *   fetch → deduplicate → enrich (Claude) → save to DB
 *
 * Writes a row to pipeline_logs at start and updates it on completion.
 *
 * @param {import('pg').Pool} [db] - Optional; creates its own Pool if omitted
 * @returns {Promise<{ saved: number, skipped: number, durationMs: number, logId: string }>}
 */
async function runPipeline(db) {
  const ownDb  = !db;
  const pool   = db || new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const trendSvc = new TrendService(pool);

  const startedAt  = Date.now();
  let totalSaved   = 0;
  let totalSkipped = 0;

  // Create pipeline log row (non-fatal if it fails)
  const logId = await createPipelineLog(pool);

  logger.info(`[Pipeline] Starting run (log_id=${logId || 'none'})`);

  try {
    for (const region of REGIONS) {
      for (const category of CATEGORIES) {
        const label = `region="${region}" category="${category}"`;

        try {
          const raw = await fetchForCombo(category, region);

          if (raw.length === 0) {
            logger.info(`[Pipeline] ${label} — 0 items fetched, skipping`);
            continue;
          }

          const tagged  = raw.map((item) => ({ ...item, category }));
          const deduped = deduplicate(tagged);
          const slice   = deduped.slice(0, MAX_ENRICH_PER_COMBO);
          const enriched = [];

          for (const item of slice) {
            const result = await enrich(item);
            if (result) {
              enriched.push(result);
            } else {
              totalSkipped++;
            }
          }

          if (enriched.length === 0) {
            logger.warn(`[Pipeline] ${label} — all enrichments failed`);
            continue;
          }

          const saved = await trendSvc.saveTrends(enriched);
          totalSaved += saved;

          logger.info(`[Pipeline] ${label} — saved ${saved} trends`);
        } catch (err) {
          logger.error(`[Pipeline] ${label} — unexpected error`, err);
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      `[Pipeline] Run complete — saved=${totalSaved} skipped=${totalSkipped} duration=${durationMs}ms`
    );

    await completePipelineLog(pool, logId, totalSaved);

    if (ownDb) await pool.end();

    return { saved: totalSaved, skipped: totalSkipped, durationMs, logId };

  } catch (err) {
    // Only hits if there's a catastrophic unexpected error outside the combo loop
    logger.error('[Pipeline] Fatal error', err);
    await failPipelineLog(pool, logId, err.message);
    if (ownDb) await pool.end();
    throw err;
  }
}

module.exports = { runPipeline };
