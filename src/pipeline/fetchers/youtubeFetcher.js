'use strict';

const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../../utils/logger');

// ─── Region maps ─────────────────────────────────────────────────────────────

/** HypeRadar region name → YouTube regionCode (ISO 3166-1 alpha-2) */
const REGION_CODE_MAP = {
  Turkiye:   'TR',
  ABD:       'US',
  Almanya:   'DE',
  Hindistan: 'IN',
  Global:    '',   // empty string = worldwide
};

/** YouTube regionCode → BCP-47 language tag (best-effort) */
const REGION_LANG_MAP = {
  TR: 'tr',
  US: 'en',
  DE: 'de',
  IN: 'hi',
  '': 'en',
};

const MAX_RESULTS = 15;
const BASE_URL    = 'https://www.googleapis.com/youtube/v3/videos';
const MODEL       = 'claude-sonnet-4-6';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the early-signal analysis prompt.
 * @param {string} region - HypeRadar region name
 * @param {Array<{ title, description }>} items - Raw YouTube video data
 * @param {string} lang - BCP-47 language code for the output
 * @returns {string}
 */
function buildYoutubePrompt(region, items, lang) {
  const dataPoints = items
    .map((v, i) => `${i + 1}. Title: ${v.title}\n   Description: ${v.description}`)
    .join('\n\n');

  const langInstruction = lang === 'tr'
    ? 'Respond in Turkish. All fields (title, description, monetization_hint) must be in Turkish.'
    : lang === 'de'
    ? 'Respond in German. All fields (title, description, monetization_hint) must be in German.'
    : lang === 'hi'
    ? 'Respond in Hindi. All fields (title, description, monetization_hint) must be in Hindi.'
    : 'Respond in English.';

  return `You are an early trend intelligence analyst for YouTube creators.

Analyze these YouTube data points and identify 5 NICHE CHANNEL OPPORTUNITIES that show early signals — topics gaining momentum in the last few days but NOT yet mainstream.

Criteria for a valid signal:
- Growing fast but still small (not already viral)
- Has a clear audience who would subscribe to a dedicated channel
- Timing advantage: someone starting TODAY would have first-mover advantage
- Specific enough to own, broad enough to sustain 100+ videos

For each opportunity return JSON:
{
  "title": "Specific niche channel concept (not generic)",
  "description": "What the channel covers + WHY this week's data suggests NOW is the right time + content format + realistic growth path. Be specific, max 4 sentences.",
  "score": 1-100 (based on: speed of growth + low competition + monetization potential),
  "monetization_hint": "Most realistic monetization for this niche"
}

If region is Turkey: also consider local cultural context, Turkish creators gap, and Turkish audience size.
If region is Global: focus on English-language international opportunities.

YouTube data points for region "${region}":

${dataPoints}

Return only valid JSON array of exactly 5 objects. No extra text.

${langInstruction}`;
}

// ─── Claude call ──────────────────────────────────────────────────────────────

/**
 * Call Claude with the batch YouTube prompt and parse the JSON array response.
 * @param {string} prompt
 * @returns {Promise<Array<object>>}
 */
async function callClaudeForYoutube(prompt) {
  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 2000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = message.content?.[0]?.text?.trim() || '';
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array from Claude');
  return parsed;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch YouTube trending videos for a region, then analyze them with Claude
 * to surface 5 early-signal niche channel opportunities.
 *
 * Returns items pre-enriched with score, description, and monetization_hint
 * so the enricher can pass them through without a second Claude call.
 *
 * @param {string} region - One of: Global | ABD | Turkiye | Almanya | Hindistan
 * @returns {Promise<Array<object>>}
 */
async function fetchYouTubeTrends(region) {
  try {
    const regionCode = REGION_CODE_MAP[region] ?? '';
    const lang       = REGION_LANG_MAP[regionCode] ?? 'en';

    // ── 1. Fetch raw YouTube most-popular videos ──────────────────────────────
    const params = {
      part:       'snippet',
      chart:      'mostPopular',
      maxResults: MAX_RESULTS,
      hl:         lang,   // host language — ensures region-appropriate content, not API-key-locale default
      key:        process.env.YOUTUBE_API_KEY,
    };
    if (regionCode) params.regionCode = regionCode;

    const { data } = await axios.get(BASE_URL, { params, timeout: 10_000 });
    const items = (data.items || []).map((item) => ({
      title:       item.snippet.title       || '',
      description: item.snippet.description || '',
    }));

    if (items.length === 0) return [];

    // ── 2. Analyze with Claude using the early-signal prompt ──────────────────
    const prompt      = buildYoutubePrompt(region, items, lang);
    const opportunities = await callClaudeForYoutube(prompt);

    // ── 3. Shape results to match the enricher's output contract ─────────────
    return opportunities.slice(0, 5).map((opp) => {
      const score = parseInt(opp.score, 10);
      return {
        title:             String(opp.title             || '').slice(0, 255),
        description:       String(opp.description       || ''),
        score:             Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
        monetization_hint: String(opp.monetization_hint || ''),
        category:          'youtube',
        region,
        lang,
        source:            'youtube',
        pre_enriched:      true,   // signals enricher to skip re-processing
      };
    });
  } catch (err) {
    logger.error(`[YouTubeFetcher] Failed for region="${region}"`, err);
    return [];
  }
}

module.exports = { fetchYouTubeTrends };
