'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../utils/logger');

// Model specified by the project. Note: the API model ID is `claude-sonnet-4-6`
// (the date-suffixed ID requested does not match current API naming — this is the
// correct equivalent).
const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Build the enrichment prompt for Claude.
 * @param {{ title, description, category, region }} trend
 * @param {string} langInstruction - Language directive appended to the prompt
 * @returns {string}
 */
function buildPrompt({ title, description, category, region }, langInstruction) {
  return `You are a trend analyst. Given the following trend data, return ONLY a valid JSON object with no explanation, no markdown, no code blocks.

Trend title: ${title}
Trend description: ${description}
Category: ${category}
Region: ${region}

Return this exact JSON structure:
{
  "title": "concise title max 10 words",
  "description": "2-3 sentence summary of why this is trending",
  "score": "number between 0 and 100 indicating trend strength",
  "monetization_hint": "1-2 sentence actionable business opportunity"
}

${langInstruction}`;
}

/**
 * Call Claude and parse the JSON response. Returns null on unrecoverable failure.
 * @param {string} prompt
 * @returns {Promise<object|null>}
 */
async function callClaude(prompt) {
  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 512,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = message.content?.[0]?.text?.trim() || '';
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned); // throws on bad JSON — caller handles retry
}

/**
 * Enrich a single raw trend with Claude-generated score, improved description,
 * and monetization hint.
 *
 * Retry policy: one automatic retry on JSON parse failure; returns null after
 * two consecutive failures so the pipeline can skip this item cleanly.
 *
 * @param {{ title, description, category, region, source }} rawTrend
 * @param {'en'|'tr'} lang - Target language for the enriched output
 * @returns {Promise<object|null>} Enriched trend or null if both attempts fail
 */
async function enrich(rawTrend, lang = 'en') {
  // Items pre-enriched by their fetcher (e.g. YouTube batch analysis) already
  // have score, description, and monetization_hint set — pass through directly.
  if (rawTrend.pre_enriched) {
    const { pre_enriched, ...rest } = rawTrend;
    return rest;
  }

  const langInstruction = lang === 'tr'
    ? 'Respond in Turkish. Translate all fields to Turkish.'
    : 'Respond in English.';

  const prompt = buildPrompt(rawTrend, langInstruction);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callClaude(prompt);

      // Validate required fields and coerce types
      const score = parseInt(parsed.score, 10);

      return {
        title:             String(parsed.title             || rawTrend.title).slice(0, 255),
        description:       String(parsed.description       || rawTrend.description),
        score:             Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
        monetization_hint: String(parsed.monetization_hint || ''),
        // Preserve original metadata
        category:          rawTrend.category,
        region:            rawTrend.region,
        lang,
        source:            rawTrend.source,
      };
    } catch (err) {
      if (attempt === 1) {
        logger.warn(`[Enricher] Attempt 1 failed for "${rawTrend.title}" (lang=${lang}) — ${err.message}, retrying...`);
      } else {
        logger.error(`[Enricher] Both attempts failed for "${rawTrend.title}" (lang=${lang}) — ${err.message}`, err);
      }
    }
  }

  return null;
}

module.exports = { enrich };
