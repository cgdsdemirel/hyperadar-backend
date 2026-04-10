'use strict';

const ALLOWED_REGIONS     = new Set(['Global', 'ABD', 'Turkiye', 'Almanya', 'Hindistan']);
const ALLOWED_CATEGORIES  = new Set(['youtube', 'github', 'ai_tools', 'reddit']);

/**
 * Validates POST /query body: regions + categories.
 *
 * Rules enforced here (structural only — plan-tier limits are enforced in QueryService):
 *   - regions:    array, 1–2 items, each from ALLOWED_REGIONS
 *   - categories: array, 1–2 items, each from ALLOWED_CATEGORIES
 *
 * Returns 400 with a descriptive message on any violation.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateQueryInput(req, res, next) {
  const { regions, categories } = req.body;

  // ── regions ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(regions) || regions.length === 0) {
    return res.status(400).json({ error: 'regions must be a non-empty array' });
  }
  if (regions.length > 2) {
    return res.status(400).json({ error: 'regions may contain at most 2 items' });
  }

  const invalidRegion = regions.find((r) => !ALLOWED_REGIONS.has(r));
  if (invalidRegion !== undefined) {
    return res.status(400).json({
      error: `Invalid region "${invalidRegion}". Allowed values: ${[...ALLOWED_REGIONS].join(', ')}`,
    });
  }

  // ── categories ───────────────────────────────────────────────────────────────
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: 'categories must be a non-empty array' });
  }
  if (categories.length > 2) {
    return res.status(400).json({ error: 'categories may contain at most 2 items' });
  }

  const invalidCategory = categories.find((c) => !ALLOWED_CATEGORIES.has(c));
  if (invalidCategory !== undefined) {
    return res.status(400).json({
      error: `Invalid category "${invalidCategory}". Allowed values: ${[...ALLOWED_CATEGORIES].join(', ')}`,
    });
  }

  next();
}

module.exports = { validateQueryInput, ALLOWED_REGIONS, ALLOWED_CATEGORIES };
