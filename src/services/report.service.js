const Payment = require('../models/payment.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Attendance = require('../models/attendance.model');
const Expense = require('../models/expense.model');
const Complaint = require('../models/complaint.model');
const Enquiry = require('../models/enquiry.model');
const Plan = require('../models/plan.model');
const Notice = require('../models/notice.model');
const Story = require('../models/story.model');
const Banner = require('../models/banner.model');
const Coupon = require('../models/coupon.model');
const ApiError = require('../utils/ApiError');
const { startOfDayIST, endOfDayIST, addDaysIST, istDateKey } = require('../utils/time');
const { hasPath, branchCond, rangeFilter, round1, pct, istDayExpr, oid } = require('./reportQuery');
const ds = require('./reportDatasets');

const NON_LIVE = ['cancelled', 'waived', 'refunded'];
const EFFECTIVE_DATE = { $ifNull: ['$paymentDate', '$createdAt'] };
const JSON_EXPORT_MAX = 10000;

const period = (q) => (q.start && q.end ? { start: istDateKey(q.start), end: istDateKey(q.end) } : null);

const IGNORED_NOTE = (q, supported) => {
    const ignored = [];
    if (q.branchId && !supported.branchId) ignored.push('branchId');
    return ignored;
};

// Collect up to `max` rows of a dataset (used for small aggregate datasets)
const collect = async (name, L, q, max = 500) => {
    const out = [];
    for await (const row of ds.iterateDataset(name, L, q)) { out.push(row); if (out.length >= max) break; }
    return out;
};

const withList = async (view, views, L, q, fallback) => {
    const name = views[view] || views[fallback];
    const list = await ds.runDataset(name, L, q);
    return { view: Object.keys(views).find((k) => views[k] === name), items: list.rows, columns: list.columns, pagination: list.pagination, viewTotals: list.totals };
};

/* ------------------------------------------------------------------ finance */
const FINANCE_VIEWS = { collection: 'payments', all: 'payments_all', dues: 'dues', overdue: 'overdue', refunds: 'refunds', credit: 'credit', partial: 'partial' };

exports.getFinanceReport = async (L, q) => {
    const base = await ds.paymentBase(L, q);
    const paid = { ...base, paidAmount: { $gt: 0 } };
    const openDue = { libraryId: L, ...branchCond(q), paymentStatus: { $nin: NON_LIVE }, dueAmount: { $gt: 0 } };

    const [sumAgg, methodAgg, statusAgg, dailyAgg, outstandingAgg, topDue, list] = await Promise.all([
        Payment.aggregate([{ $match: base }, { $group: {
            _id: null, totalBilled: { $sum: '$totalAmount' }, totalCollected: { $sum: '$paidAmount' }, totalDue: { $sum: '$dueAmount' },
            totalLateFee: { $sum: '$lateFee' }, totalDiscount: { $sum: '$discountAmount' }, totalWaived: { $sum: '$waivedAmount' }, totalRefunded: { $sum: '$refundAmount' }, count: { $sum: 1 }
        } }]),
        Payment.aggregate([{ $match: paid }, { $group: { _id: '$paymentMethod', totalAmount: { $sum: '$paidAmount' }, count: { $sum: 1 } } }, { $sort: { totalAmount: -1 } }]),
        Payment.aggregate([{ $match: base }, { $group: { _id: '$paymentStatus', totalAmount: { $sum: '$paidAmount' }, totalDue: { $sum: '$dueAmount' }, count: { $sum: 1 } } }]),
        Payment.aggregate([
            { $match: paid },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: EFFECTIVE_DATE, timezone: 'Asia/Kolkata' } }, collected: { $sum: '$paidAmount' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]),
        Payment.aggregate([{ $match: openDue }, { $group: {
            _id: null, outstanding: { $sum: '$dueAmount' }, accounts: { $sum: 1 },
            overdueAmount: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, '$dueAmount', 0] } },
            overdueAccounts: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, 1, 0] } }
        } }]),
        Payment.find(openDue).sort({ dueAmount: -1 }).limit(10).populate('studentId', 'name mobile rollNumber seatNumber').lean(),
        withList(q.view, FINANCE_VIEWS, L, q, 'collection')
    ]);

    const s = sumAgg[0] || { totalBilled: 0, totalCollected: 0, totalDue: 0, totalLateFee: 0, totalDiscount: 0, totalWaived: 0, totalRefunded: 0, count: 0 };
    delete s._id;
    const netBillable = s.totalBilled + s.totalLateFee - s.totalDiscount - s.totalWaived;
    const o = outstandingAgg[0] || {};
    return {
        period: period(q),
        summary: {
            ...s, netCollected: s.totalCollected - s.totalRefunded,
            collectionRate: netBillable > 0 ? pct(s.totalCollected, netBillable) : 0
        },
        paymentMethods: methodAgg.map((m) => ({ method: m._id || 'cash', total: m.totalAmount, count: m.count })),
        paymentStatuses: statusAgg.map((x) => ({ status: x._id || 'unknown', total: x.totalAmount, due: x.totalDue, count: x.count })),
        dailyTrend: dailyAgg.map((x) => ({ date: x._id, collected: x.collected, count: x.count })),
        outstanding: { total: o.outstanding || 0, accounts: o.accounts || 0, overdueAmount: o.overdueAmount || 0, overdueAccounts: o.overdueAccounts || 0, note: 'All-time open dues, not limited to the selected period' },
        topDefaulters: topDue.map((p) => ({
            studentName: p.studentId?.name || 'Unknown', mobile: p.studentId?.mobile || '', rollNumber: p.studentId?.rollNumber || '',
            seatNumber: p.studentId?.seatNumber || '', dueAmount: p.dueAmount, dueDate: p.dueDate
        })),
        ...list
    };
};

/* ----------------------------------------------------------------- students */
const STUDENT_VIEWS = { master: 'students', active: 'students_active', inactive: 'students_inactive', joining: 'students_joining', expiry: 'students_expiry', expired: 'membership_expired', renewals: 'renewals' };

exports.getStudentsReport = async (L, q) => {
    const now = new Date();
    const today = startOfDayIST(now);
    const scope = { ...q, status: undefined, search: q.search };
    const base = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true } };
    if (q.planId) base.planId = oid(q.planId);
    const seatIds = await ds.seatIdsForLocation(L, q);
    if (seatIds) base.seatId = { $in: seatIds };

    const [statusCounts, newAdmissions, expiringSoon, expired, planDist, renewals, list] = await Promise.all([
        Student.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Student.countDocuments({ ...base, ...(q.start ? { joiningDate: rangeFilter(q) } : {}) }),
        Student.countDocuments({ ...base, status: 'active', expiryDate: { $gte: today, $lte: endOfDayIST(addDaysIST(now, q.days)) } }),
        Student.countDocuments({ ...base, expiryDate: { $lt: today } }),
        Student.aggregate([{ $match: { ...base, planId: { $ne: null } } }, { $group: { _id: '$planId', count: { $sum: 1 } } }]),
        Payment.countDocuments({ libraryId: L, ...branchCond(q), paymentType: 'renewal', paidAmount: { $gt: 0 }, paymentStatus: { $ne: 'cancelled' }, ...(q.start ? { $or: [{ paymentDate: rangeFilter(q) }, { paymentDate: null, createdAt: rangeFilter(q) }] } : {}) }),
        withList(q.view, STUDENT_VIEWS, L, q, 'master')
    ]);
    const plans = await Plan.find({ libraryId: L, _id: { $in: planDist.map((p) => p._id) } }).select('name').lean();
    const pm = new Map(plans.map((p) => [String(p._id), p.name]));
    const sm = { active: 0, inactive: 0, suspended: 0 };
    let total = 0;
    statusCounts.forEach((s) => { if (sm[s._id] !== undefined) sm[s._id] = s.count; total += s.count; });
    void scope;
    return {
        period: period(q),
        totalStudents: total, activeStudents: sm.active, inactiveStudents: sm.inactive, suspendedStudents: sm.suspended,
        newAdmissionsInPeriod: newAdmissions, renewalsInPeriod: renewals, expiredMemberships: expired,
        expiringSoonCount: expiringSoon, expiringInDays: q.days,
        planWiseDistribution: planDist.map((p) => ({ planId: p._id, planName: pm.get(String(p._id)) || 'Custom Plan', studentsCount: p.count })),
        ignoredFilters: IGNORED_NOTE(q, { branchId: hasPath(Student, 'branchId') || hasPath(Seat, 'branchId') }),
        ...list
    };
};

/* ---------------------------------------------------------------- attendance */
const ATT_VIEWS = { logs: 'attendance', daily: 'attendance_daily', monthly: 'attendance_monthly', student: 'attendance_student', shift: 'attendance_shift' };

exports.getAttendanceReport = async (L, q) => {
    const [daily, topStudents, shifts, list, active] = await Promise.all([
        collect('attendance_daily', L, q, 400),
        ds.runDataset('attendance_student', L, { ...q, page: 1, limit: 15 }),
        collect('attendance_shift', L, q, 10),
        withList(q.view, ATT_VIEWS, L, q, 'daily'),
        Student.countDocuments({ libraryId: L, ...branchCond(q), status: 'active', isDeleted: { $ne: true } })
    ]);
    const totalCheckIns = daily.reduce((a, d) => a + d.checkIns, 0);
    const totalPresent = daily.reduce((a, d) => a + d.present, 0);
    return {
        period: period(q),
        activeStudents: active, totalAttendanceLogs: totalCheckIns, daysCovered: daily.length,
        averageDailyAttendance: daily.length ? round1(totalPresent / daily.length) : 0,
        averageAttendancePct: active > 0 && daily.length ? round1((totalPresent / daily.length / active) * 100) : 0,
        dailyTrend: daily.map((d) => ({ date: d.date, present: d.present, avgDurationMinutes: d.avgMinutes, attendancePct: d.attendancePct })),
        shiftWise: shifts,
        topStudents: topStudents.rows,
        ...list
    };
};

/* --------------------------------------------------------------------- seats */
exports.getSeatReport = async (L, q) => {
    const match = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true } };
    if (q.floor) match.floor = q.floor;
    if (q.room) match.room = q.room;
    if (q.type) match.type = q.type;
    if (q.branchId && hasPath(Seat, 'branchId')) match.branchId = oid(q.branchId);
    const [counts, locAgg, typeAgg, list] = await Promise.all([
        Seat.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, price: { $sum: '$price' } } }]),
        Seat.aggregate([{ $match: match }, { $group: {
            _id: { floor: '$floor', room: '$room' }, total: { $sum: 1 },
            occupied: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } },
            available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
            reserved: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
            unavailable: { $sum: { $cond: [{ $in: ['$status', ['blocked', 'maintenance']] }, 1, 0] } }
        } }, { $sort: { '_id.floor': 1, '_id.room': 1 } }]),
        Seat.aggregate([{ $match: match }, { $group: { _id: '$type', total: { $sum: 1 }, occupied: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } } } }]),
        ds.runDataset('seats', L, q)
    ]);
    const sm = { available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 };
    let total = 0;
    let potential = 0;
    counts.forEach((c) => { if (sm[c._id] !== undefined) sm[c._id] = c.count; total += c.count; potential += c.price || 0; });
    const bookable = total - sm.blocked - sm.maintenance;
    return {
        totalSeats: total, occupied: sm.occupied, available: sm.available, reserved: sm.reserved, maintenance: sm.maintenance, blocked: sm.blocked,
        bookableSeats: bookable, occupancyRate: pct(sm.occupied, bookable), monthlyRevenuePotential: potential,
        floorWiseBreakdown: locAgg.map((f) => ({
            floor: f._id.floor || 'Main Floor', room: f._id.room || 'Main Hall', total: f.total, occupied: f.occupied, available: f.available, reserved: f.reserved,
            unavailable: f.unavailable, occupancyRate: pct(f.occupied, f.total - f.unavailable)
        })),
        typeBreakdown: typeAgg.map((t) => ({ type: t._id, total: t.total, occupied: t.occupied })),
        seatHistory: { available: true, note: 'Use /reports/data/seat_history (or /reports/export?type=seat_history) for assignment events; /reports/bi/occupancy-trend for daily occupancy' },
        items: list.rows, columns: list.columns, pagination: list.pagination
    };
};

/* ---------------------------------------------------------------- membership */
const MEMBERSHIP_VIEWS = { new: 'students_joining', renewals: 'renewals', expiring: 'students_expiry', expired: 'membership_expired' };

exports.getMembershipReport = async (L, q) => {
    const now = new Date();
    const today = startOfDayIST(now);
    const live = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true } };
    const payRange = q.start ? { $or: [{ paymentDate: rangeFilter(q) }, { paymentDate: null, createdAt: rangeFilter(q) }] } : {};
    const [created, renewals, expiring, expired, list] = await Promise.all([
        Student.countDocuments({ ...live, ...(q.start ? { joiningDate: rangeFilter(q) } : {}) }),
        Payment.countDocuments({ libraryId: L, ...branchCond(q), paymentType: 'renewal', paidAmount: { $gt: 0 }, paymentStatus: { $ne: 'cancelled' }, ...payRange }),
        Student.countDocuments({ ...live, status: 'active', expiryDate: { $gte: today, $lte: endOfDayIST(addDaysIST(now, q.days)) } }),
        Student.countDocuments({ ...live, expiryDate: { $lt: today } }),
        withList(q.view, MEMBERSHIP_VIEWS, L, q, 'new')
    ]);
    return { period: period(q), expiringInDays: q.days, summary: { newMemberships: created, renewals, expiring, expired }, ...list };
};

/* ------------------------------------------------------------------ enquiries */
const ENQ_VIEWS = { all: 'enquiries', followups: 'enquiry_followups' };

exports.getEnquiryReport = async (L, q) => {
    const match = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true }, ...(q.start ? { createdAt: rangeFilter(q) } : {}) };
    const conv = { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } };
    const [byStatus, bySource, dueCount, list] = await Promise.all([
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$source', total: { $sum: 1 }, converted: conv } }, { $sort: { total: -1 } }]),
        Enquiry.countDocuments({ libraryId: L, ...branchCond(q), followUpDate: { $lte: endOfDayIST(now()) }, status: { $nin: ['converted', 'rejected', 'closed'] } }),
        withList(q.view, ENQ_VIEWS, L, q, 'all')
    ]);
    const total = byStatus.reduce((a, s) => a + s.count, 0);
    const converted = byStatus.find((s) => s._id === 'converted')?.count || 0;
    return {
        period: period(q),
        summary: { total, new: byStatus.find((s) => s._id === 'new')?.count || 0, converted, conversionRatePct: pct(converted, total), followUpsDue: dueCount },
        byStatus: byStatus.map((s) => ({ status: s._id, count: s.count })),
        conversionBySource: bySource.map((s) => ({ source: s._id || 'other', total: s.total, converted: s.converted, conversionRatePct: pct(s.converted, s.total) })),
        ...list
    };
};
const now = () => new Date();

/* -------------------------------------------------------------------- content */
exports.getContentReport = async (L) => {
    const t = new Date();
    const [notices, stories, banners, offers] = await Promise.all([
        Promise.all([Notice.countDocuments({ libraryId: L }), Notice.countDocuments({ libraryId: L, isActive: true })]),
        Promise.all([Story.countDocuments({ libraryId: L }), Story.countDocuments({ libraryId: L, isActive: true, expiresAt: { $gt: t } })]),
        Promise.all([Banner.countDocuments({ libraryId: L }), Banner.countDocuments({ libraryId: L, isActive: true, startDate: { $lte: t }, endDate: { $gte: t } })]),
        Promise.all([Coupon.countDocuments({ libraryId: L }), Coupon.countDocuments({ libraryId: L, isActive: true, startDate: { $lte: t }, endDate: { $gte: t } })])
    ]);
    const shape = ([total, published]) => ({ total, published, unpublished: total - published });
    return { asOf: istDateKey(t), notices: shape(notices), stories: shape(stories), banners: shape(banners), offers: shape(offers) };
};

/* ----------------------------------------------------------------- complaints */
exports.getComplaintReport = async (L, q) => {
    const match = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true }, ...(q.start ? { createdAt: rangeFilter(q) } : {}) };
    if (q.branchId) match.branchId = oid(q.branchId);
    const [statusAgg, catAgg, tat, list] = await Promise.all([
        Complaint.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Complaint.aggregate([{ $match: match }, { $group: { _id: '$category', total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 0, 1] } } } }, { $sort: { total: -1 } }]),
        Complaint.aggregate([{ $match: { ...match, resolvedAt: { $ne: null } } }, { $group: { _id: null, avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } }, resolved: { $sum: 1 } } }]),
        ds.runDataset('complaints', L, q)
    ]);
    const sm = Object.fromEntries(statusAgg.map((s) => [s._id, s.count]));
    const total = statusAgg.reduce((a, s) => a + s.count, 0);
    const resolved = (sm.resolved || 0) + (sm.closed || 0);
    return {
        period: period(q),
        summary: { total, open: total - resolved, resolved, byStatus: sm, avgTurnaroundHours: tat[0] ? round1(tat[0].avgMs / 3600000) : null, turnaroundSample: tat[0]?.resolved || 0 },
        byCategory: catAgg.map((c) => ({ category: c._id, total: c.total, open: c.open })),
        items: list.rows, columns: list.columns, pagination: list.pagination
    };
};

/* -------------------------------------------------------------------- website */
exports.getWebsiteReport = async (L, q) => {
    const match = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true }, source: 'website', ...(q.start ? { createdAt: rangeFilter(q) } : {}) };
    const [agg, daily, list] = await Promise.all([
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Enquiry.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, enquiries: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } }, { $sort: { _id: 1 } }]),
        ds.runDataset('website_enquiries', L, q)
    ]);
    const total = agg.reduce((a, s) => a + s.count, 0);
    const converted = agg.find((s) => s._id === 'converted')?.count || 0;
    return {
        period: period(q),
        summary: { enquiries: total, converted, conversionRatePct: pct(converted, total) },
        byStatus: agg.map((s) => ({ status: s._id, count: s.count })),
        dailyTrend: daily.map((d) => ({ date: d._id, enquiries: d.enquiries, converted: d.converted })),
        note: 'Page-view / visitor analytics are not tracked; conversion is measured from website enquiries only',
        items: list.rows, columns: list.columns, pagination: list.pagination
    };
};

/* ------------------------------------------------------------------------ P&L */
exports.getPnLReport = async (L, q) => {
    const payMatch = { libraryId: L, ...branchCond(q), paymentStatus: { $ne: 'cancelled' }, ...(q.start ? { $or: [{ paymentDate: rangeFilter(q) }, { paymentDate: null, createdAt: rangeFilter(q) }] } : {}) };
    const expMatch = { libraryId: L, ...branchCond(q), isDeleted: { $ne: true }, ...(q.start ? { date: rangeFilter(q) } : {}) };
    const [inc, exp, cat, monthly, expMonthly] = await Promise.all([
        Payment.aggregate([{ $match: payMatch }, { $group: { _id: null, collected: { $sum: '$paidAmount' }, refunds: { $sum: '$refundAmount' } } }]),
        Expense.aggregate([{ $match: expMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expense.aggregate([{ $match: expMatch }, { $group: { _id: '$category', totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { totalAmount: -1 } }]),
        Payment.aggregate([{ $match: payMatch }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: EFFECTIVE_DATE, timezone: 'Asia/Kolkata' } }, revenue: { $sum: { $subtract: ['$paidAmount', '$refundAmount'] } } } }, { $sort: { _id: 1 } }]),
        Expense.aggregate([{ $match: expMatch }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'Asia/Kolkata' } }, expense: { $sum: '$amount' } } }, { $sort: { _id: 1 } }])
    ]);
    const collected = inc[0]?.collected || 0;
    const refunds = inc[0]?.refunds || 0;
    const totalRevenue = collected - refunds;
    const totalExpense = exp[0]?.total || 0;
    const netProfit = totalRevenue - totalExpense;
    const months = new Map();
    monthly.forEach((m) => months.set(m._id, { period: m._id, revenue: m.revenue, expense: 0 }));
    expMonthly.forEach((m) => { const r = months.get(m._id) || { period: m._id, revenue: 0, expense: 0 }; r.expense = m.expense; months.set(m._id, r); });
    return {
        period: period(q),
        grossCollected: collected, refunds, totalRevenue, totalExpense, netProfit,
        profitMargin: totalRevenue > 0 ? round1((netProfit / totalRevenue) * 100) : 0,
        status: netProfit >= 0 ? 'Profitable' : 'Loss',
        monthly: [...months.values()].sort((a, b) => a.period.localeCompare(b.period)).map((m) => ({ ...m, net: m.revenue - m.expense })),
        expenseBreakdown: cat.map((c) => ({ category: c._id || 'other', amount: c.totalAmount, percentage: totalExpense > 0 ? round1((c.totalAmount / totalExpense) * 100) : 0, count: c.count }))
    };
};

/* ----------------------------------------------------------------- data (paged) */
exports.getDataset = async (type, L, q) => ds.runDataset(type, L, q);
exports.listTypes = () => ds.listTypes();

/* ------------------------------------------------------------------ json export */
exports.exportJson = async (type, L, q) => {
    const rows = await collect(type, L, q, JSON_EXPORT_MAX + 1);
    if (rows.length > JSON_EXPORT_MAX) throw new ApiError(413, `JSON export is limited to ${JSON_EXPORT_MAX} rows. Use format=csv or format=xlsx for the full dataset.`);
    return { type: ds.resolveName(type), count: rows.length, data: rows };
};

void istDayExpr;

/* ------------------------------------------------------- per-branch breakdown */
/**
 * Consolidated multi-branch view: one row per branch (plus an "Unassigned" row for records
 * that carry no branch yet). `allowedIds` limits the rows for branch-limited staff.
 * Owners get all branches; the totals row is the consolidated figure for the rows returned.
 */
exports.getBranchBreakdown = async (L, allowedIds = null) => {
    const Branch = require('../models/branch.model');
    const PaymentTransaction = require('../models/paymentTransaction.model');
    const bf = { libraryId: L, isDeleted: { $ne: true } };
    if (allowedIds && allowedIds.length) bf._id = { $in: allowedIds.map(oid) };
    const branches = await Branch.find(bf).sort({ isMain: -1, createdAt: 1 }).select('name isMain isActive city').lean();

    const todayStart = startOfDayIST(new Date());
    const todayEnd = endOfDayIST(new Date());
    const limit = allowedIds && allowedIds.length ? { branchId: { $in: allowedIds.map(oid) } } : {};

    const [students, seats, collection, dues, attendance] = await Promise.all([
        Student.aggregate([{ $match: { libraryId: L, isDeleted: { $ne: true }, ...limit } }, { $group: { _id: '$branchId', total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }]),
        Seat.aggregate([{ $match: { libraryId: L, isDeleted: { $ne: true }, ...limit } }, { $group: { _id: '$branchId', total: { $sum: 1 }, occupied: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } } } }]),
        PaymentTransaction.aggregate([
            { $match: { libraryId: L, status: 'success', paymentDate: { $gte: todayStart, $lte: todayEnd }, ...limit } },
            { $group: { _id: '$branchId', total: { $sum: { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] } } } }
        ]),
        Payment.aggregate([
            { $match: { libraryId: L, paymentStatus: { $in: ['partial', 'credit', 'overdue'] }, dueAmount: { $gt: 0 }, ...limit } },
            { $group: { _id: '$branchId', total: { $sum: '$dueAmount' }, count: { $sum: 1 } } }
        ]),
        Attendance.aggregate([
            { $match: { libraryId: L, status: 'present', date: { $gte: todayStart, $lte: todayEnd }, ...limit } },
            { $group: { _id: { b: '$branchId', s: '$studentId' } } },
            { $group: { _id: '$_id.b', present: { $sum: 1 } } }
        ])
    ]);
    const key = (id) => (id ? String(id) : 'none');
    const idx = (arr) => new Map(arr.map((r) => [key(r._id), r]));
    const sM = idx(students); const seM = idx(seats); const cM = idx(collection); const dM = idx(dues); const aM = idx(attendance);

    const row = (id, name, extra = {}) => {
        const k = key(id);
        const st = sM.get(k) || {}; const se = seM.get(k) || {};
        return {
            branchId: id || null, name, ...extra,
            students: st.total || 0, activeStudents: st.active || 0,
            seatsTotal: se.total || 0, seatsOccupied: se.occupied || 0,
            occupancyRate: pct(se.occupied || 0, se.total || 0),
            todayCollection: round1((cM.get(k) || {}).total || 0),
            pendingDues: round1((dM.get(k) || {}).total || 0),
            pendingDueCount: (dM.get(k) || {}).count || 0,
            attendanceToday: (aM.get(k) || {}).present || 0
        };
    };
    const rows = branches.map((b) => row(b._id, b.name, { isMain: !!b.isMain, isActive: b.isActive !== false, city: b.city || '' }));
    // Records not tied to a branch yet (only visible to unrestricted users)
    if (!allowedIds || !allowedIds.length) {
        const un = row(null, 'Unassigned', { isMain: false, isActive: true, city: '' });
        if (un.students || un.seatsTotal || un.todayCollection || un.pendingDues || un.attendanceToday) rows.push(un);
    }
    const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
    const totals = {
        students: sum('students'), activeStudents: sum('activeStudents'), seatsTotal: sum('seatsTotal'), seatsOccupied: sum('seatsOccupied'),
        todayCollection: round1(sum('todayCollection')), pendingDues: round1(sum('pendingDues')), attendanceToday: sum('attendanceToday')
    };
    totals.occupancyRate = pct(totals.seatsOccupied, totals.seatsTotal);
    return { asOf: istDateKey(new Date()), branches: rows, totals };
};
