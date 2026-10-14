// Shared query helpers for report / BI services: tenant casting, IST date ranges, pagination, search.
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const { startOfDayIST, endOfDayIST, monthRangeIST, addDaysIST } = require('../utils/time');

const IST = 'Asia/Kolkata';

const oid = (v) => {
    if (v instanceof mongoose.Types.ObjectId) return v;
    if (v && v._id) return oid(v._id);
    if (!v || !mongoose.Types.ObjectId.isValid(String(v))) throw new ApiError(400, 'Invalid id');
    return new mongoose.Types.ObjectId(String(v));
};

// Branch condition from a parsed report query: q.branchId (single) or q.branchIds (branch-limited staff).
// Returns {} when unrestricted (consolidated view across all branches).
const branchCond = (q = {}, field = 'branchId') => {
    if (Array.isArray(q.branchIds) && q.branchIds.length) return { [field]: { $in: q.branchIds.map(oid) } };
    if (q.branchId) return { [field]: oid(q.branchId) };
    return {};
};

const hasPath = (Model, p) => !!Model.schema.path(p);

const MAX_RANGE_DAYS = 400;

/**
 * Normalise common report query params. Dates are IST calendar days.
 * defaults: 'month' (current IST month to date), 'none' (no default), or number of trailing days.
 */
const parseQuery = (query = {}, { defaultRange = 'month' } = {}) => {
    const q = { ...query };
    let start = null;
    let end = null;
    if (q.startDate) start = startOfDayIST(q.startDate);
    if (q.endDate) end = endOfDayIST(q.endDate);
    if ((start && isNaN(start)) || (end && isNaN(end))) throw new ApiError(400, 'Invalid date');
    if (!start && !end && defaultRange !== 'none') {
        if (defaultRange === 'month') {
            start = monthRangeIST().start;
            end = endOfDayIST(new Date());
        } else {
            end = endOfDayIST(new Date());
            start = addDaysIST(new Date(), -(Number(defaultRange) - 1));
        }
    }
    if (start && !end) end = endOfDayIST(new Date());
    if (end && !start) start = new Date(0);
    if (start && end && start > end) throw new ApiError(400, 'startDate must not be after endDate');
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));
    const search = q.search ? String(q.search).trim().slice(0, 60) : '';
    return {
        ...q, start, end, page, limit, search,
        days: q.days !== undefined ? Math.min(365, Math.max(1, parseInt(q.days, 10) || 7)) : (q.expiringInDays !== undefined ? Math.min(365, Math.max(1, parseInt(q.expiringInDays, 10) || 7)) : 7)
    };
};

const requireRange = (p, maxDays = MAX_RANGE_DAYS) => {
    if (p.end - p.start > maxDays * 86400000) throw new ApiError(400, `Date range cannot exceed ${maxDays} days`);
    return p;
};

const rangeFilter = (p) => (p.start && p.end ? { $gte: p.start, $lte: p.end } : undefined);

const searchRegex = (s) => new RegExp(escapeRegex(s), 'i');

const pagination = (p, total) => ({ page: p.page, limit: p.limit, total, pages: Math.max(1, Math.ceil(total / p.limit)) });

const round1 = (n) => Math.round((n || 0) * 10) / 10;
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : 0);

const istDayExpr = (field, fmt = '%Y-%m-%d') => ({ $dateToString: { format: fmt, date: field, timezone: IST } });

module.exports = {
    IST, oid, hasPath, branchCond, parseQuery, requireRange, rangeFilter, searchRegex, pagination,
    round1, pct, istDayExpr, MAX_RANGE_DAYS
};
