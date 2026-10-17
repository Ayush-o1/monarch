import express from 'express';
import { requireUser } from '../../middleware/requireUser.js';
import { slugifyPropertyLabel } from './formatters.js';
import { loadReportData } from './service.js';
import { createReport } from './pdf.js';

/**
 * Creates the express router for handover report generation.
 *
 * @param {object} options
 * @param {object} options.pool
 * @param {object} [options.storage]
 * @returns {express.Router}
 */
export function createReportRouter({ pool, storage } = {}) {
  const router = express.Router();

  router.use(requireUser);

  router.get('/:id/report.pdf', async (req, res, next) => {
    try {
      // 1. Load ALL data and images first before setting headers
      const data = await loadReportData(req.params.id, req.session.user.id, {
        pool,
        storage,
      });

      // 2. Format ASCII filename
      const slug = slugifyPropertyLabel(data.tenancy.propertyLabel);
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const filename = `handover-${slug}-${yyyy}-${mm}-${dd}.pdf`;

      // 3. Render PDF document
      const compress = req.query.compress !== 'false';
      const doc = createReport(data, { compress });

      // 4. Set headers
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      doc.on('error', (err) => {
        console.warn('PDF stream error:', err.message);
        if (!res.destroyed) {
          res.destroy(err);
        }
      });

      res.on('error', (err) => {
        console.warn('Response error during PDF stream:', err.message);
        if (doc && typeof doc.destroy === 'function') {
          doc.destroy();
        }
      });

      doc.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
