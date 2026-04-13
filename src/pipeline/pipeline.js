'use strict';

require('dotenv').config();

const https  = require('https');
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
const { fetchSectorTrends }     = require('./fetchers/sectorsFetcher');
const { fetchJobTrends }        = require('./fetchers/jobsFetcher');
const { fetchStartupTrends }    = require('./fetchers/startupsFetcher');

// ─── Config ───────────────────────────────────────────────────────────────────

const REGIONS    = ['Global', 'ABD', 'Turkiye', 'Almanya', 'Hindistan'];
const CATEGORIES = ['youtube', 'github', 'ai_tools', 'reddit', 'sectors', 'jobs', 'startups'];

const MAX_ENRICH_PER_COMBO = 5;

/**
 * Maps each HypeRadar region to its native output language.
 * Used to select the second (localised) enrichment language per region.
 * English-speaking regions produce only one version ('en').
 */
const REGION_NATIVE_LANG = {
  Global:    'en',
  ABD:       'en',
  Turkiye:   'tr',
  Almanya:   'de',
  Hindistan: 'hi',
};

// ─── Expo Push helpers ────────────────────────────────────────────────────────

/**
 * POST a batch of messages to the Expo Push API (https://exp.host/--/api/v2/push/send).
 * The API accepts up to 100 messages per request.
 * Non-throwing — errors are logged but never propagate to the caller.
 *
 * @param {object[]} messages
 */
function expoPost(messages) {
  return new Promise((resolve) => {
    const body = JSON.stringify(messages);
    const req  = https.request(
      {
        hostname: 'exp.host',
        path:     '/--/api/v2/push/send',
        method:   'POST',
        headers: {
          'Content-Type':    'application/json',
          'Accept':          'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Length':  Buffer.byteLength(body),
        },
      },
      (res) => { res.resume(); resolve(); }  // consume response to free socket
    );
    req.on('error', (err) => {
      logger.error('[Pipeline] Expo Push request error', err);
      resolve();   // never reject — notifications are best-effort
    });
    req.write(body);
    req.end();
  });
}

/**
 * After each pipeline run, find high-score trends (>= 80) created in the
 * last 10 minutes and broadcast push notifications to all registered users.
 * Capped at 5 distinct trend alerts per run to avoid spam.
 *
 * @param {import('pg').Pool} pool
 */
async function sendPushNotifications(pool) {
  try {
    // Trends saved in this run with high score
    const { rows: trends } = await pool.query(
      `SELECT id, title
         FROM trends
        WHERE score       >= 80
          AND created_at  >= now() - interval '10 minutes'
        ORDER BY score DESC
        LIMIT 5`
    );
    if (trends.length === 0) return;

    // Users who have opted in to push notifications
    const { rows: users } = await pool.query(
      `SELECT push_token FROM users WHERE push_token IS NOT NULL`
    );
    if (users.length === 0) return;

    const tokens = users.map((u) => u.push_token);

    logger.info(
      `[Pipeline] Sending push notifications — ${trends.length} trend(s), ${tokens.length} user(s)`
    );

    // One broadcast per high-score trend; batch each in chunks of 100
    for (const trend of trends) {
      const messages = tokens.map((token) => ({
        to:    token,
        title: '🔥 Yüksek Puanlı Trend!',
        body:  trend.title,
        data:  { trend_id: trend.id },
      }));

      for (let i = 0; i < messages.length; i += 100) {
        await expoPost(messages.slice(i, i + 100));
      }
    }

    logger.info(`[Pipeline] Push notifications dispatched`);
  } catch (err) {
    logger.error('[Pipeline] sendPushNotifications failed', err);
  }
}

// ─── Dedup filter ────────────────────────────────────────────────────────────

/**
 * Remove trends that already exist in the DB today (same title + region + category).
 * Prevents re-saving identical items on repeated pipeline runs within the same day.
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} trends
 * @returns {Promise<object[]>} Only the trends not yet saved today
 */
async function filterExistingTrends(pool, trends) {
  const fresh = [];
  for (const trend of trends) {
    const { rows } = await pool.query(
      `SELECT 1 FROM trends
        WHERE title        = $1
          AND region       = $2
          AND category     = $3
          AND created_at::date = CURRENT_DATE
        LIMIT 1`,
      [trend.title, trend.region, trend.category]
    );
    if (rows.length === 0) fresh.push(trend);
  }
  return fresh;
}

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

    case 'sectors':
      // Global-only: the fetcher aggregates cross-source headlines into sector
      // signals via one LLM call. The pipeline's enrich() loop then produces
      // bilingual (EN + TR) records from the returned raw items.
      if (region !== 'Global') return [];
      return fetchSectorTrends(region);

    case 'jobs':
      // Global-only: groups job titles by normalised role, counts frequency,
      // then sends the top-N table to the LLM to identify growth signals.
      if (region !== 'Global') return [];
      return fetchJobTrends(region);

    case 'startups':
      // Global-only: collects startup news summaries (name + funding snippet),
      // sends them to the LLM to identify the 5 with the most momentum.
      if (region !== 'Global') return [];
      return fetchStartupTrends(region);

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

          // Bug 3 fix: use the region's native language for the second enrichment
          // call instead of hardcoding 'tr' for every region.
          const regionNativeLang = REGION_NATIVE_LANG[region] || 'en';

          for (const item of slice) {
            const enResult = await enrich(item, 'en');
            if (enResult) {
              enriched.push(enResult);
            } else {
              totalSkipped++;
            }

            // Only produce a native-language version when the region is non-English
            if (regionNativeLang !== 'en') {
              const nativeResult = await enrich(item, regionNativeLang);
              if (nativeResult) {
                enriched.push(nativeResult);
              } else {
                totalSkipped++;
              }
            }
          }

          if (enriched.length === 0) {
            logger.warn(`[Pipeline] ${label} — all enrichments failed`);
            continue;
          }

          // Bug 2 fix: skip trends already saved today (same title + region + category)
          const fresh = await filterExistingTrends(pool, enriched);
          if (fresh.length === 0) {
            logger.info(`[Pipeline] ${label} — all trends already exist today, skipping`);
            continue;
          }

          const saved = await trendSvc.saveTrends(fresh);
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

    // Send push notifications for high-score trends (best-effort, non-blocking)
    await sendPushNotifications(pool);

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
