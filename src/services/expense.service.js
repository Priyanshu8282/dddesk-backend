const mongoose = require('mongoose');
const Expense = require('../models/expense.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');
const { startOfDayIST, endOfDayIST } = require('../utils/time');

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

const toData = (body) => {
    const d = pick(body, ['title', 'amount', 'category', 'paymentMethod', 'date', 'notes', 'receiptImage', 'branchId']); // branchId is validated by the controller
    if (body.category !== undefined) d.category = normalizeCategory(body.category);
    if (d.notes === undefined && body.description !== undefined) d.notes = body.description;
    if (d.date !== undefined) d.date = parseDate(d.date, 'expense');
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
    if (query.search && String(query.search).trim()) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ title: rx }, { notes: rx }];
    }
    return filter;
};

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
exports.listExpenses = async (libraryId, query = {}, scope = {}) => {
    const filter = buildFilter(libraryId, query, scope);
    const exporting = query.export === 'true' || query.export === true || query.format === 'csv';
    const page = exporting ? 1 : Math.max(1, parseInt(query.page, 10) || 1);
    const limit = exporting ? 5000 : Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

    const [data, total, byCategory] = await Promise.all([
        Expense.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('createdBy', 'name').lean(),
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

exports.toCsv = (rows) => {
    const head = ['Date', 'Title', 'Category', 'Amount', 'Payment Method', 'Notes', 'Recorded By'];
    const lines = rows.map((r) => [
        r.date ? new Date(r.date).toISOString().slice(0, 10) : '', r.title, r.category, r.amount, r.paymentMethod, r.notes,
        r.createdBy && r.createdBy.name
    ].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n');
};

exports.normalizeCategory = normalizeCategory;
exports.CATEGORIES = CATEGORIES;
