// Role-based dashboard summaries (superadmin platform view, library owner/staff view).
// Payload shapes: backend/doc/dashboard-contract.md. Existing /dashboard/admin and /dashboard/superadmin stay in dashboard.service.js.
const mongoose = require('mongoose');
const Student = require('../models/student.model');
const Payment = require('../models/payment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const PlatformPayment = require('../models/platformPayment.model');
const PlatformPlan = require('../models/platformPlan.model');
const Attendance = require('../models/attendance.model');
const Seat = require('../models/seat.model');
const Library = require('../models/library.model');
const Notice = require('../models/notice.model');
const ApiError = require('../utils/ApiError');
const TtlCache = require('../utils/ttlCache');
const { startOfDayIST, endOfDayIST, addDaysIST } = require('../utils/time');
const { branchFilter } = require('../utils/branchScope');
const M = require('../utils/dashboardMath');

const CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS ?? 20000);
const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, max: 500 });

const oid = (v) => new mongoose.Types.ObjectId(String(v && v._id ? v._id : v));
const DUE_STATUSES = ['partial', 'credit', 'overdue'];
const SEAT_LIMIT = 400;
const SUPER_RANGES = ['year', '6m', '30d'];
const LIB_RANGES = ['week', 'month', 'year'];
const LIB_RANGE_BUCKETS = { week: 'week', month: 'month', year: 'yearFull' };
const img = (l) => l.logo || l.profileImage || null;

const LIBRARY_STATUS_LABEL = { active: 'approved', pending: 'pending', rejected: 'rejected', suspended: 'suspended' };

const netExpr = { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] };

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------
const pickRange = (value, allowed, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(String(value))) throw new ApiError(400, `Invalid range. Use one of: ${allowed.join(', ')}`);
  return String(value);
};
exports.SUPER_RANGES = SUPER_RANGES;
exports.LIB_RANGES = LIB_RANGES;
exports.pickSuperRange = (v) => pickRange(v, SUPER_RANGES, 'year');
exports.pickLibraryRange = (v) => pickRange(v, LIB_RANGES, 'week');

// ---------------------------------------------------------------------------
// Permissions (library dashboard)
// ---------------------------------------------------------------------------
const QUICK_ACTIONS = [
  { key: 'add_student', label: 'Add Student', to: 'students/add-student', needs: ['students.create'] },
  { key: 'mark_attendance', label: 'Mark Attendance', to: 'attendance', needs: ['attendance.checkin'] },
  { key: 'collect_fee', label: 'Collect Payment', to: 'payments', needs: ['fees.collect'] },
  { key: 'manage_seats', label: 'Manage Seats', to: 'seats', needs: ['seats.assign', 'seats.manage'] },
  { key: 'add_notice', label: 'Add Notice', to: 'notices', needs: ['content.create'] },
];

/** Which dashboard sections this request may see. Owners and superadmin see everything; staff follow their role. */
const permissionsFor = (req) => {
  const full = !req || req.userType !== 'staff';
  const has = (...keys) => full || keys.some((k) => (req.permissions || []).includes(k));
  const flags = {
    students: has('students.view'),
    seats: has('seats.view'),
    attendance: has('attendance.view'),
    fees: has('fees.view'),
    notices: has('content.view'),
  };
  const quickActions = QUICK_ACTIONS.map(({ needs, ...a }) => ({ ...a, allowed: has(...needs) }));
  return { flags, quickActions };
};
exports.permissionsFor = permissionsFor;

const flagsKey = (f) => ['students', 'seats', 'attendance', 'fees', 'notices'].map((k) => (f[k] ? '1' : '0')).join('');

// ---------------------------------------------------------------------------
// Superadmin
// ---------------------------------------------------------------------------
const monthlyRows = (Model, match, field, kind, extra = {}) => Model.aggregate([
  { $match: match },
  { $group: { _id: M.bucketKeyExpr(`$${field}`, kind), v: extra.sum ? { $sum: extra.sum } : { $sum: 1 } } },
]);

const buildSuperadmin = async (range, now = new Date()) => {
  const b12 = M.buildBuckets('12m', now);
  const start12 = b12.buckets[0].start;
  const rangeSpec = M.buildBuckets(range, now);
  const rangeStart = rangeSpec.buckets[0].start;
  const taxable = { $ifNull: ['$taxableAmount', '$amount'] };
  const in7 = new Date(now.getTime() + 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const live = { isDeleted: { $ne: true } };
  const endExpr = { $ifNull: ['$subscriptionExpiry', '$trialEndsAt'] };
  const cnt = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const trialExpr = { $or: [{ $eq: ['$subscriptionIsTrial', true] }, { $and: [{ $eq: [{ $ifNull: ['$subscriptionExpiry', null] }, null] }, { $gt: [{ $ifNull: ['$trialEndsAt', null] }, null] }] }] };
  const approved = { $in: ['$status', ['active', 'suspended']] };
  const expiredCond = {
    $or: [
      { $and: [{ $eq: ['$status', 'active'] }, { $gt: [endExpr, null] }, { $lt: [endExpr, now] }] },
      { $and: [{ $eq: ['$status', 'suspended'] }, { $eq: ['$statusReason', 'Subscription expired'] }] },
    ],
  };
  const expiringCond = { $and: [{ $eq: ['$status', 'active'] }, { $gte: [endExpr, now] }, { $lte: [endExpr, in7] }] };
  const activeCond = { $and: [{ $eq: ['$status', 'active'] }, { $not: [expiredCond] }, { $not: [expiringCond] }] };

  const dailyRange = rangeSpec.kind === 'day';
  const [
    libByMonth, libBefore, stuByMonth, stuBefore,
    libDaily, stuDaily, stuBeforeRange, libStatusAgg,
    plansAgg, revByMonth, recent, pending, pendingCount,
    topAgg, payments, payAgg, paidPeriods,
  ] = await Promise.all([
    monthlyRows(Library, { ...live, createdAt: { $gte: start12 } }, 'createdAt', 'month'),
    Library.countDocuments({ ...live, createdAt: { $lt: start12 } }),
    monthlyRows(Student, { ...live, createdAt: { $gte: start12 } }, 'createdAt', 'month'),
    Student.countDocuments({ ...live, createdAt: { $lt: start12 } }),
    dailyRange ? monthlyRows(Library, { ...live, createdAt: { $gte: rangeStart } }, 'createdAt', 'day') : [],
    dailyRange ? monthlyRows(Student, { ...live, createdAt: { $gte: rangeStart } }, 'createdAt', 'day') : [],
    dailyRange ? Student.countDocuments({ ...live, createdAt: { $lt: rangeStart } }) : 0,
    Library.aggregate([{ $match: live }, { $group: {
      _id: null,
      active: cnt(activeCond), expiringSoon: cnt(expiringCond), expired: cnt(expiredCond),
      suspended: cnt({ $and: [{ $eq: ['$status', 'suspended'] }, { $not: [expiredCond] }] }),
      trial: cnt({ $and: [{ $eq: ['$status', 'active'] }, { $not: [expiredCond] }, trialExpr] }),
    } }]),
    Library.aggregate([{ $match: { ...live, status: { $in: ['active', 'suspended'] } } },
      { $group: { _id: '$subscriptionPlanId', count: { $sum: 1 }, fallbackName: { $first: '$subscriptionPlan' } } }]),
    monthlyRows(PlatformPayment, { status: 'paid', paidAt: { $gte: start12 } }, 'paidAt', 'month', { sum: taxable }),
    Library.find(live).sort({ createdAt: -1 }).limit(5)
      .select('name ownerName status city state createdAt subscriptionPlan logo profileImage').lean(),
    Library.find({ ...live, status: 'pending' }).sort({ createdAt: 1 }).limit(5).select('name ownerName city state createdAt').lean(),
    Library.countDocuments({ ...live, status: 'pending' }),
    Student.aggregate([{ $match: live }, { $group: { _id: '$libraryId', students: { $sum: 1 } } },
      { $sort: { students: -1 } }, { $limit: 5 }]),
    PlatformPayment.find({ status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).limit(5)
      .select('libraryId amount status paidAt createdAt').populate('libraryId', 'name logo profileImage').lean(),
    PlatformPayment.aggregate([{ $group: { _id: null,
      failed: cnt({ $and: [{ $eq: ['$status', 'failed'] }, { $gte: ['$createdAt', thirtyDaysAgo] }] }),
      grace: cnt({ $and: [{ $eq: ['$inGrace', true] }, { $gte: ['$graceUntil', now] }] }),
    } }]),
    PlatformPayment.find({ status: 'paid', $or: [{ periodEnd: { $gte: start12 } }, { periodEnd: null }, { paidAt: { $gte: start12 } }] })
      .select('libraryId periodStart periodEnd paidAt').limit(20000).lean(),
  ]);

  // KPI series (12 months)
  const libSeries = M.cumulative(M.fillSeries(b12.buckets, libByMonth), libBefore);
  const stuSeries = M.cumulative(M.fillSeries(b12.buckets, stuByMonth), stuBefore);
  const revSeries = M.fillSeries(b12.buckets, revByMonth);
  const thisRevenue = revSeries[revSeries.length - 1].value;
  const lastRevenue = revSeries.length > 1 ? revSeries[revSeries.length - 2].value : 0;

  // Subscription status
  const ls = libStatusAgg[0] || {};
  const subTotal = (ls.active || 0) + (ls.expiringSoon || 0) + (ls.expired || 0);
  const subscriptionStatus = {
    total: subTotal,
    active: { count: ls.active || 0, percent: M.percentOf(ls.active || 0, subTotal) },
    expiringSoon: { count: ls.expiringSoon || 0, percent: M.percentOf(ls.expiringSoon || 0, subTotal) },
    expired: { count: ls.expired || 0, percent: M.percentOf(ls.expired || 0, subTotal) },
    trial: ls.trial || 0,
    suspended: ls.suspended || 0,
  };

  // "Active plans" trend: libraries with a paid subscription period covering each month end
  const payingAt = (t) => {
    const set = new Set();
    for (const p of paidPeriods) {
      const from = (p.periodStart || p.paidAt) && new Date(p.periodStart || p.paidAt).getTime();
      const to = p.periodEnd ? new Date(p.periodEnd).getTime() : (p.paidAt ? new Date(p.paidAt).getTime() + 30 * 86400000 : 0);
      if (from <= t && t <= to) set.add(String(p.libraryId));
    }
    return set.size;
  };
  const planSpark = b12.buckets.map((b, i) => ({
    key: b.key, label: b.label,
    value: i === b12.buckets.length - 1 ? subscriptionStatus.active.count : payingAt(Math.min(b.end.getTime() - 1, now.getTime())),
  }));

  // Range charts
  let regTrend, stuGrowth;
  if (rangeSpec.kind === 'month') {
    const n = rangeSpec.buckets.length;
    const idx = b12.buckets.length - n;
    regTrend = M.fillSeries(rangeSpec.buckets, libByMonth);
    stuGrowth = stuSeries.slice(idx);
  } else {
    regTrend = M.fillSeries(rangeSpec.buckets, libDaily);
    stuGrowth = M.cumulative(M.fillSeries(rangeSpec.buckets, stuDaily), stuBeforeRange);
  }

  // Libraries by plan
  const planIds = plansAgg.map((p) => p._id).filter(Boolean);
  const planDocs = planIds.length ? await PlatformPlan.find({ _id: { $in: planIds } }).select('name').lean() : [];
  const planName = new Map(planDocs.map((p) => [String(p._id), p.name]));
  const planTotal = plansAgg.reduce((a, p) => a + p.count, 0);
  const librariesByPlan = {
    total: planTotal,
    items: M.shares(plansAgg.map((p) => ({
      planId: p._id ? String(p._id) : null,
      name: (p._id && planName.get(String(p._id))) || p.fallbackName || 'No plan',
      count: p.count,
    })).sort((a, b) => b.count - a.count), planTotal),
  };

  // Top libraries
  const topIds = topAgg.map((t) => t._id).filter(Boolean);
  const topDocs = topIds.length ? await Library.find({ _id: { $in: topIds } }).select('name logo profileImage').lean() : [];
  const topMap = new Map(topDocs.map((l) => [String(l._id), l]));
  const topLibraries = topAgg.filter((t) => topMap.has(String(t._id))).map((t) => {
    const l = topMap.get(String(t._id));
    return { id: String(t._id), name: l.name, logo: img(l), students: t.students };
  });

  const pa = payAgg[0] || {};
  const alerts = [];
  if (pendingCount > 0) alerts.push({ type: 'pending_approvals', severity: 'warning', message: `${pendingCount} library registration(s) awaiting approval`, count: pendingCount });
  if (pa.failed > 0) alerts.push({ type: 'failed_payments', severity: 'danger', message: `${pa.failed} failed subscription payment(s) in the last 30 days`, count: pa.failed });
  if (subscriptionStatus.expired.count > 0) alerts.push({ type: 'expired_subscriptions', severity: 'danger', message: `${subscriptionStatus.expired.count} librar${subscriptionStatus.expired.count > 1 ? 'ies have' : 'y has'} an expired subscription`, count: subscriptionStatus.expired.count });
  if (pa.grace > 0) alerts.push({ type: 'in_grace', severity: 'warning', message: `${pa.grace} librar${pa.grace > 1 ? 'ies are' : 'y is'} in a payment grace period`, count: pa.grace });
  if (subscriptionStatus.expiringSoon.count > 0) alerts.push({ type: 'expiring_subscriptions', severity: 'warning', message: `${subscriptionStatus.expiringSoon.count} subscription(s) expire within 7 days`, count: subscriptionStatus.expiringSoon.count });

  return {
    role: 'superadmin',
    generatedAt: now.toISOString(),
    range,
    kpis: {
      totalLibraries: M.kpiFromSeries(libSeries.slice(-12)),
      totalStudents: M.kpiFromSeries(stuSeries.slice(-12)),
      monthlyRevenue: { ...M.kpiFromSeries(revSeries, { value: thisRevenue, prev: lastRevenue }), currency: 'INR' },
      activePlans: M.kpiFromSeries(planSpark, { value: subscriptionStatus.active.count, prev: planSpark.length > 1 ? planSpark[planSpark.length - 2].value : 0 }),
    },
    registrationTrend: { range, points: regTrend },
    librariesByPlan,
    revenueOverview: { thisMonth: thisRevenue, lastMonth: lastRevenue, changePct: M.pctChange(thisRevenue, lastRevenue), points: revSeries },
    recentRegistrations: recent.map((l) => ({
      id: String(l._id), name: l.name, ownerName: l.ownerName || null, plan: l.subscriptionPlan || null,
      createdAt: l.createdAt, status: LIBRARY_STATUS_LABEL[l.status] || l.status, logo: img(l), city: l.city || null, state: l.state || null,
    })),
    subscriptionStatus,
    topLibraries,
    studentGrowth: { range, points: stuGrowth },
    paymentActivity: payments.map((p) => ({
      id: String(p._id), libraryId: p.libraryId ? String(p.libraryId._id || p.libraryId) : null,
      libraryName: p.libraryId?.name || 'Deleted library', logo: p.libraryId ? img(p.libraryId) : null,
      amount: p.amount, status: p.status, at: p.paidAt || p.createdAt,
    })),
    pendingApprovals: {
      count: pendingCount,
      items: pending.map((l) => ({ id: String(l._id), name: l.name, ownerName: l.ownerName || null, city: l.city || null, state: l.state || null, createdAt: l.createdAt })),
    },
    alerts,
  };
};

exports.getSuperadminSummary = (range) => cache.wrap(`super|r:${range}`, () => buildSuperadmin(range));

exports.getSuperadminCharts = async (range) => {
  const s = await exports.getSuperadminSummary(range);
  return { range, registrationTrend: s.registrationTrend, studentGrowth: s.studentGrowth, revenueOverview: s.revenueOverview };
};

// ---------------------------------------------------------------------------
// Library owner / staff
// ---------------------------------------------------------------------------
const feesSeries = async (libId, scope, range, now) => {
  const spec = M.buildBuckets(LIB_RANGE_BUCKETS[range], now);
  const rows = await PaymentTransaction.aggregate([
    { $match: { libraryId: libId, ...scope, status: 'success', paymentDate: { $gte: spec.buckets[0].start, $lt: spec.buckets[spec.buckets.length - 1].end } } },
    { $group: { _id: M.bucketKeyExpr('$paymentDate', spec.kind), v: { $sum: netExpr } } },
  ]);
  const points = M.fillSeries(spec.buckets, rows);
  return { range, total: M.round2(points.reduce((a, p) => a + p.value, 0)), points };
};

const buildLibrary = async (libId, scope, flags, range, now = new Date()) => {
  const b7 = M.buildBuckets('7m', now);
  const start7 = b7.buckets[0].start;
  const todayStart = startOfDayIST(now), todayEnd = endOfDayIST(now), in7 = endOfDayIST(addDaysIST(now, 7));
  const sBase = { libraryId: libId, ...scope, isDeleted: false };
  const none = Promise.resolve(null);
  const cnt = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

  const noticeFilter = {
    libraryId: libId, isActive: true,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
      ...(scope.branchId ? [{ $or: [{ branchId: null }, { branchId: scope.branchId }] }] : []),
    ],
  };

  const [
    stuByMonth, stuBefore, activeStudents,
    present, insideNow,
    expiringCount, expiringItems, recentStudents,
    seatCounts, seatList,
    feeMonths, pendingAgg, feesChart,
    notices,
  ] = await Promise.all([
    flags.students ? Student.aggregate([{ $match: { ...sBase, createdAt: { $gte: start7 } } },
      { $group: { _id: M.bucketKeyExpr('$createdAt', 'month'), v: { $sum: 1 } } }]) : none,
    flags.students ? Student.countDocuments({ ...sBase, createdAt: { $lt: start7 } }) : none,
    flags.attendance ? Student.countDocuments({ ...sBase, status: 'active', planStatus: 'active' }) : none,
    flags.attendance ? Attendance.distinct('studentId', { libraryId: libId, ...scope, date: { $gte: todayStart, $lte: todayEnd }, status: 'present' }) : none,
    flags.attendance ? Attendance.countDocuments({ libraryId: libId, ...scope, open: true }) : none,
    flags.students ? Student.countDocuments({ ...sBase, planStatus: 'active', expiryDate: { $gte: todayStart, $lte: in7 } }) : none,
    flags.students ? Student.find({ ...sBase, planStatus: 'active', expiryDate: { $gte: todayStart, $lte: in7 } })
      .sort({ expiryDate: 1 }).limit(5).select('name registrationNumber profileImage expiryDate').lean() : none,
    flags.students ? Student.find(sBase).sort({ createdAt: -1 }).limit(5)
      .select('name profileImage joiningDate createdAt status seatNumber').lean() : none,
    flags.seats ? Seat.aggregate([{ $match: { libraryId: libId, ...scope, isDeleted: false } }, { $group: { _id: '$status', n: { $sum: 1 } } }]) : none,
    flags.seats ? Seat.find({ libraryId: libId, ...scope, isDeleted: false }).select('seatNumber status').sort({ seatNumber: 1 }).limit(SEAT_LIMIT).lean() : none,
    flags.fees ? PaymentTransaction.aggregate([
      { $match: { libraryId: libId, ...scope, status: 'success', paymentDate: { $gte: start7 } } },
      { $group: { _id: M.bucketKeyExpr('$paymentDate', 'month'), v: { $sum: netExpr } } }]) : none,
    flags.fees ? Payment.aggregate([
      { $match: { libraryId: libId, ...scope, paymentStatus: { $in: DUE_STATUSES }, dueAmount: { $gt: 0 } } },
      { $group: { _id: '$studentId', due: { $sum: '$dueAmount' } } },
      { $group: { _id: null, amount: { $sum: '$due' }, students: { $sum: 1 } } }]) : none,
    flags.fees ? feesSeries(libId, scope, range, now) : none,
    flags.notices ? Notice.find(noticeFilter).sort({ isPinned: -1, startDate: -1 }).limit(4).select('title type startDate isPinned createdAt').lean() : none,
  ]);

  // Students KPI: total now + 7 month cumulative
  let totalStudents = null;
  if (flags.students) {
    const series = M.cumulative(M.fillSeries(b7.buckets, stuByMonth), stuBefore);
    totalStudents = M.kpiFromSeries(series);
  }

  // Seats
  let occupiedSeats = null, seatLayout = null;
  if (flags.seats) {
    const counts = { available: 0, occupied: 0, reserved: 0, maintenance: 0 };
    let total = 0;
    seatCounts.forEach((s) => { counts[M.normalizeSeatStatus(s._id)] += s.n; total += s.n; });
    occupiedSeats = { occupied: counts.occupied, total, percent: M.percentOf(counts.occupied, total) };
    seatLayout = { total, truncated: total > seatList.length, counts, rows: M.groupSeatsIntoRows(seatList) };
  }

  // Attendance
  let attendanceToday = null;
  if (flags.attendance) {
    const presentCount = present.length;
    // someone without an active plan can still be marked present (trial/manual): never show more present than the total
    const attTotal = Math.max(activeStudents, presentCount);
    attendanceToday = {
      present: presentCount, absent: Math.max(attTotal - presentCount, 0), total: attTotal,
      presentPercent: M.percentOf(presentCount, attTotal), insideNow,
    };
  }

  // Fees
  let feesCollected = null, pendingFees = null, feesCollection = null;
  if (flags.fees) {
    const series = M.fillSeries(b7.buckets, feeMonths);
    feesCollected = M.kpiFromSeries(series);
    pendingFees = { amount: M.round2(pendingAgg[0]?.amount || 0), students: pendingAgg[0]?.students || 0 };
    feesCollection = feesChart;
  }

  return {
    kpis: { totalStudents, occupiedSeats, feesCollected, pendingFees },
    attendanceToday,
    membershipExpiring: flags.students ? {
      count: expiringCount,
      items: expiringItems.map((s) => ({
        id: String(s._id), studentId: s.registrationNumber || null, name: s.name, photo: s.profileImage || null,
        daysLeft: Math.max(M.daysLeftIST(s.expiryDate, now), 0), expiryDate: s.expiryDate,
      })),
    } : null,
    recentStudents: flags.students ? recentStudents.map((s) => ({
      id: String(s._id), name: s.name, photo: s.profileImage || null, joinedAt: s.joiningDate || s.createdAt, status: s.status, seat: s.seatNumber || null,
    })) : null,
    feesCollection,
    seatLayout,
    notices: flags.notices ? notices.map((n) => ({ id: String(n._id), title: n.title, type: n.type, date: n.startDate || n.createdAt, pinned: !!n.isPinned })) : null,
  };
};

/**
 * Library dashboard summary. `req` supplies role, permissions, branch scope and the user name.
 * The expensive part is cached per (library, branch scope, permission flags, range); the greeting is built per request.
 */
exports.getLibrarySummary = async (libraryId, req, range) => {
  if (!libraryId) throw new ApiError(400, 'No library associated with this account');
  const libId = oid(libraryId);
  const scope = branchFilter(req);
  const { flags, quickActions } = permissionsFor(req);
  const key = `lib:${libId}|b:${JSON.stringify(scope)}|p:${flagsKey(flags)}|r:${range}`;
  const [data, library] = await Promise.all([
    cache.wrap(key, () => buildLibrary(libId, scope, flags, range)),
    Library.findById(libId).select('name logo profileImage').lean(),
  ]);
  const limited = req.userType === 'staff' && ((req.user && req.user.branchIds) || []).length > 0;
  return {
    role: req.userType === 'staff' ? 'staff' : 'admin',
    generatedAt: new Date().toISOString(),
    greeting: {
      userName: (req.user && req.user.name) || null,
      libraryName: library?.name || null,
      libraryLogo: library ? img(library) : null,
      today: new Date(startOfDayIST(new Date()).getTime() + 330 * 60000).toISOString().slice(0, 10),
      branchScope: limited ? 'limited' : 'all',
    },
    permissions: { ...flags, quickActions },
    ...data,
  };
};

exports.getLibraryCharts = async (libraryId, req, range) => {
  const libId = oid(libraryId);
  const scope = branchFilter(req);
  const { flags } = permissionsFor(req);
  if (!flags.fees) return { range, feesCollection: null };
  const key = `lib:${libId}|b:${JSON.stringify(scope)}|chart|r:${range}`;
  const feesCollection = await cache.wrap(key, () => feesSeries(libId, scope, range, new Date()));
  return { range, feesCollection };
};

/** Drop cached summaries (called by realtime emitters whenever data changes). */
exports.invalidateLibrary = (libraryId) => { if (libraryId) cache.invalidate(`lib:${String(libraryId)}|`); };
exports.invalidatePlatform = () => cache.invalidate('super|');
exports.clearCache = () => cache.clear();
exports._cache = cache;
exports._internals = { buildLibrary, buildSuperadmin, feesSeries };
