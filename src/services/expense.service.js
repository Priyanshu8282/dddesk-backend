const mongoose = require('mongoose');
const Expense = require('../models/expense.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');
const { startOfDayIST, endOfDayIST, istDateKey, IST_OFFSET_MS } = require('../utils/time');

const CATEGORIES = Expense.schema.path('category').enumValues;
const SYNONYMS = {
    general: 'other', misc: 'other', miscellaneous: 'other',
    utilities: 'electricity', utility: 'electricity', 'electricity bill': 'electricity', power: 'electricity',
    wifi: 'internet', broadband: 'internet',
    salaries: 'salary', wages: 'salary', 'staff salary': 'salary',
    repair: 'maintenance', repairs: 'maintenance',
    stationery: 'supplies', supply: 'supplies',
    housekeeping: 'cleaning'
};

// Case-insensitive; unknown / 'General' -> 'other'
const normalizeCategory = (c) => {
    const k = String(c || '').trim().toLowerCase();
    if (!k) return 'other';
    if (CATEGORIES.includes(k)) return k;
    return SYNONYMS[k] || 'other';
};

const parseDate = (v, label) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, `Invalid ${label} date`);
    return d;
};

const PLAIN_OTHER = ['other', 'general', 'misc', 'miscellaneous'];

const toData = (body) => {
    const d = pick(body, ['title', 'amount', 'category', 'paymentMethod', 'date', 'vendor', 'notes', 'receiptImage', 'branchId']); // branchId is validated by the controller
    if (body.category !== undefined || body.customCategory !== undefined) {
        const raw = String(body.category || '').trim();
        const cat = normalizeCategory(raw);
        if (body.category !== undefined) d.category = cat;
        if (cat === 'other') {
            // A name typed by the owner ("Tea & snacks") is kept as the display label of the "other" category
            const typed = body.customCategory !== undefined ? String(body.customCategory).trim()
                : (raw && !PLAIN_OTHER.includes(raw.toLowerCase()) && !SYNONYMS[raw.toLowerCase()] ? raw : '');
            d.customCategory = typed.slice(0, 40);
        } else {
            d.customCategory = '';
        }
    }
    if (d.notes === undefined && body.description !== undefined) d.notes = body.description;
    if (d.date !== undefined) {
        d.date = parseDate(d.date, 'expense');
        if (d.date.getTime() > endOfDayIST(new Date()).getTime()) throw new ApiError(400, 'Expense date cannot be in the future');
    }
    return d;
};

exports.createExpense = async (body, libraryId, createdBy, branchId = null) => {
    const data = toData(body);
    if (data.category === undefined) data.category = 'other';
    return Expense.create({ ...data, libraryId, createdBy, branchId: branchId || null });
};

const buildFilter = (libraryId, query, scope = {}) => {
    const filter = { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, ...scope };
    if (query.category) filter.category = normalizeCategory(query.category);
    if (query.paymentMethod) filter.paymentMethod = String(query.paymentMethod);
    if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = startOfDayIST(parseDate(query.from, 'from'));
        if (query.to) filter.date.$lte = endOfDayIST(parseDate(query.to, 'to'));
        if (filter.date.$gte && filter.date.$lte && filter.date.$gte > filter.date.$lte) throw new ApiError(400, 'from must be before to');
    }
    const lo = query.minAmount !== undefined && query.minAmount !== '' ? Number(query.minAmount) : null;
    const hi = query.maxAmount !== undefined && query.maxAmount !== '' ? Number(query.maxAmount) : null;
    if (lo !== null || hi !== null) {
        if (lo !== null && hi !== null && lo > hi) throw new ApiError(400, 'Minimum amount must not be more than maximum amount');
        filter.amount = {};
        if (lo !== null) filter.amount.$gte = lo;
        if (hi !== null) filter.amount.$lte = hi;
    }
    if (query.search && String(query.search).trim()) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ title: rx }, { notes: rx }, { vendor: rx }, { customCategory: rx }];
    }
    return filter;
};

const SORTS = {
    newest: { date: -1, _id: -1 },
    oldest: { date: 1, _id: 1 },
    amount_high: { amount: -1, _id: -1 },
    amount_low: { amount: 1, _id: 1 },
    title: { title: 1, _id: 1 }
};

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
exports.listExpenses = async (libraryId, query = {}, scope = {}) => {
    const filter = buildFilter(libraryId, query, scope);
    const exporting = query.export === 'true' || query.export === true || query.format === 'csv';
    const page = exporting ? 1 : Math.max(1, parseInt(query.page, 10) || 1);
    const limit = exporting ? 5000 : Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

    const [data, total, byCategory] = await Promise.all([
        Expense.find(filter).sort(SORTS[query.sort] || SORTS.newest).skip((page - 1) * limit).limit(limit).populate('createdBy', 'name').lean(),
        Expense.countDocuments(filter),
        Expense.aggregate([
            { $match: filter },
            { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            { $sort: { total: -1 } }
        ])
    ]);
    const totalAmount = Math.round(byCategory.reduce((s, c) => s + c.total, 0) * 100) / 100;
    return {
        data, total, page, limit, totalPages: Math.ceil(total / limit), totalAmount,
        stats: {
            totalAmount, count: total,
            byCategory: byCategory.map((c) => ({ category: c._id, total: Math.round(c.total * 100) / 100, count: c.count }))
        }
    };
};

exports.getExpense = async (id, libraryId) => Expense.findOne({ _id: id, libraryId }).populate('createdBy', 'name');

exports.updateExpense = async (id, libraryId, body) => {
    const expense = await Expense.findOne({ _id: id, libraryId });
    if (!expense) return null;
    const data = toData(body);
    Object.keys(data).forEach((k) => { expense[k] = data[k]; });
    await expense.save();
    return expense;
};

exports.deleteExpense = async (id, libraryId) =>
    Expense.findOneAndUpdate({ _id: id, libraryId, isDeleted: false }, { $set: { isDeleted: true } }, { new: true });

const csvCell = (v) => {
    let s = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const CSV_HEAD = ['Date', 'Title', 'Category', 'Amount', 'Payment Method', 'Vendor', 'Notes', 'Recorded By'];
const csvRow = (r) => [
    r.date ? istDateKey(r.date) : '', r.title, r.customCategory || r.category, r.amount, r.paymentMethod, r.vendor, r.notes,
    r.createdBy && r.createdBy.name
].map(csvCell).join(',');

exports.toCsv = (rows) => [CSV_HEAD.join(','), ...rows.map(csvRow)].join('\n');

// Streams every matching row (same filters as the list) to `write`
exports.exportExpensesCsv = async (libraryId, query, scope, write) => {
    const filter = buildFilter(libraryId, query, scope);
    await write('﻿' + CSV_HEAD.join(',') + '\n');
    const cursor = Expense.find(filter).sort(SORTS[query.sort] || SORTS.newest).limit(20000).populate('createdBy', 'name').lean().cursor();
    let n = 0;
    for await (const r of cursor) { await write(csvRow(r) + '\n'); n++; }
    return n;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Everything the dashboard cards and charts need, in one aggregate round trip
exports.getSummary = async (libraryId, scope = {}) => {
    const now = new Date();
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const monthStart = (offset) => new Date(Date.UTC(y, m + offset, 1) - IST_OFFSET_MS);
    const keys = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - i, 1));
        keys.push({ key: d.toISOString().slice(0, 7), year: d.getUTCFullYear(), month: d.getUTCMonth() });
    }
    const base = { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, ...scope };
    const sum = { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } };
    const [r] = await Expense.aggregate([
        { $match: { ...base, date: { $gte: monthStart(-5) } } },
        { $facet: {
            monthly: [{ $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: '+05:30' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } }],
            categories: [{ $group: { _id: { c: '$category', l: '$customCategory' }, total: { $sum: '$amount' }, count: { $sum: 1 } } }],
            thisMonthCategories: [{ $match: { date: { $gte: monthStart(0) } } }, { $group: { _id: { c: '$category', l: '$customCategory' }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }],
            today: [{ $match: { date: { $gte: startOfDayIST(now) } } }, sum]
        } }
    ]);
    const monthly = new Map((r.monthly || []).map((x) => [x._id, x]));
    const months = keys.map((k) => ({ key: k.key, year: k.year, month: k.month, total: round2(monthly.get(k.key)?.total), count: monthly.get(k.key)?.count || 0 }));
    const thisMonth = months[5].total;
    const lastMonth = months[4].total;
    const label = (id) => (id.c === 'other' && id.l ? id.l : id.c);
    // The same custom name can appear under several rows (different spellings of the same label are merged by label)
    const mergeCats = (rows) => {
        const out = new Map();
        rows.forEach((x) => { const k = label(x._id); const cur = out.get(k) || { category: x._id.c, label: k, total: 0, count: 0 }; cur.total += x.total; cur.count += x.count || 0; out.set(k, cur); });
        return [...out.values()].map((x) => ({ ...x, total: round2(x.total) })).sort((a, b) => b.total - a.total);
    };
    const top = mergeCats(r.thisMonthCategories || [])[0] || null;
    const dayOfMonth = Number(istDateKey(now).slice(8, 10));
    return {
        thisMonth, lastMonth,
        changePct: lastMonth > 0 ? Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10 : null,
        today: round2(r.today?.[0]?.total),
        todayCount: r.today?.[0]?.count || 0,
        averagePerDay: round2(thisMonth / Math.max(1, dayOfMonth)),
        topCategory: top ? { category: top.category, label: top.label, total: top.total } : null,
        months,
        byCategory: mergeCats(r.categories || [])
    };
};

exports.normalizeCategory = normalizeCategory;
exports.CATEGORIES = CATEGORIES;
