const express = require('express');
const { z } = require('zod');
const catchAsync = require('../../utils/catchAsync');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const svc = require('../../services/revenue.service');

const router = express.Router();
router.use(requireSuperAdmin);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const filters = {
    status: z.enum(['all', 'paid', 'failed', 'pending']).optional(),
    planId: objectId.optional(),
    libraryId: objectId.optional(),
    period: z.enum(['monthly', 'annual']).optional(),
    from: day.optional(),
    to: day.optional(),
    q: z.string().trim().max(80).optional(),
};
const overviewQuery = z.object({ query: z.object({ months: z.coerce.number().int().refine((n) => svc.RANGES.includes(n), 'months must be 3, 6, 12 or 24').optional() }) });
const listQuery = z.object({ query: z.object({ ...filters, page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) });
const exportQuery = z.object({ query: z.object(filters) });

// GET /v1/private/super/revenue/overview?months=12
router.get('/overview', validate(overviewQuery), catchAsync(async (req, res) => {
    const data = await svc.getOverview({ months: req.query.months });
    res.json({ success: true, message: 'Revenue overview retrieved successfully', data });
}));

// GET /v1/private/super/revenue/payments?status=&planId=&period=&from=&to=&q=&page=&limit=
router.get('/payments', validate(listQuery), catchAsync(async (req, res) => {
    const r = await svc.listPayments(req.query);
    res.json({ success: true, message: 'Subscription payments retrieved successfully', ...r });
}));

// GET /v1/private/super/revenue/export?...same filters  (CSV of the whole filtered set, up to 50,000 rows)
router.get('/export', validate(exportQuery), catchAsync(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="subscription-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    await svc.exportCsv(req.query, (chunk) => new Promise((resolve) => (res.write(chunk) ? resolve() : res.once('drain', resolve))));
    res.end();
}));

module.exports = router;
