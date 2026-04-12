'use strict';

/**
 * Report routes.
 *
 * GET /reports/weekly-pdf — auth required, premium only
 *   Generates a PDF with the top 10 trends from the last 7 days by score.
 */

const { Router }     = require('express');
const PDFDocument    = require('pdfkit');
const { authenticate } = require('../middleware/auth');
const logger         = require('../utils/logger');

const router = Router();

/**
 * GET /reports/weekly-pdf
 * Auth required. Premium users only.
 * Returns a PDF binary with the top 10 trends from the last 7 days.
 */
router.get('/weekly-pdf', authenticate, async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    // Verify user exists and is premium
    const { rows: userRows } = await db.query(
      'SELECT plan FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userRows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (userRows[0].plan !== 'premium') {
      return res.status(403).json({ error: 'Premium subscription required' });
    }

    // Fetch top 10 trends from the last 7 days by score
    const { rows: trends } = await db.query(
      `SELECT title, description, category, score
         FROM trends
        WHERE created_at >= NOW() - INTERVAL '7 days'
        ORDER BY score DESC
        LIMIT 10`
    );

    // Build date range label
    const now       = new Date();
    const weekAgo   = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const dateRange = `${fmt(weekAgo)} – ${fmt(now)}`;

    // Generate PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="weekly-trends-${fmt(now)}.pdf"`
    );

    doc.pipe(res);

    // ── Title ──────────────────────────────────────────────────────────────────
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .text('HypeRadar — Weekly Trend Report', { align: 'center' });

    doc.moveDown(0.5);

    // ── Date range ─────────────────────────────────────────────────────────────
    doc
      .fontSize(11)
      .font('Helvetica')
      .fillColor('#555555')
      .text(`Period: ${dateRange}`, { align: 'center' });

    doc.moveDown(1.5);

    // ── Divider ────────────────────────────────────────────────────────────────
    doc
      .moveTo(50, doc.y)
      .lineTo(doc.page.width - 50, doc.y)
      .strokeColor('#cccccc')
      .stroke();

    doc.moveDown(1);

    // ── Trend list ─────────────────────────────────────────────────────────────
    if (trends.length === 0) {
      doc
        .fontSize(12)
        .fillColor('#333333')
        .font('Helvetica')
        .text('No trends found for this period.', { align: 'center' });
    } else {
      trends.forEach((trend, i) => {
        // Rank + title
        doc
          .fontSize(13)
          .font('Helvetica-Bold')
          .fillColor('#111111')
          .text(`${i + 1}. ${trend.title}`);

        // Category & score on the same line
        doc
          .fontSize(10)
          .font('Helvetica')
          .fillColor('#777777')
          .text(`Category: ${trend.category}   |   Score: ${trend.score}`);

        // Description
        if (trend.description) {
          doc.moveDown(0.3);
          doc
            .fontSize(11)
            .font('Helvetica')
            .fillColor('#333333')
            .text(trend.description, { lineGap: 2 });
        }

        doc.moveDown(1);

        // Light separator between entries (skip after last)
        if (i < trends.length - 1) {
          doc
            .moveTo(50, doc.y)
            .lineTo(doc.page.width - 50, doc.y)
            .strokeColor('#eeeeee')
            .stroke();
          doc.moveDown(0.8);
        }
      });
    }

    doc.end();

    logger.info(`[Reports] weekly-pdf generated for user=${req.user.id} trends=${trends.length}`);
  } catch (err) {
    logger.error('[Reports] GET /weekly-pdf error', err);
    next(err);
  }
});

module.exports = router;
