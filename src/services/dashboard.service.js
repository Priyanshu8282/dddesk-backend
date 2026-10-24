const mongoose = require('mongoose');
const Student    = require('../models/student.model');
const Payment    = require('../models/payment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const PlatformPayment = require('../models/platformPayment.model');
const Attendance = require('../models/attendance.model');
const Seat       = require('../models/seat.model');
const Library    = require('../models/library.model');
const Enquiry    = require('../models/enquiry.model');
const Complaint  = require('../models/complaint.model');
const { startOfDayIST, endOfDayIST, addDaysIST, IST_OFFSET_MS } = require('../utils/time');
const { getSubscriptionState } = require('./subscriptionState.service');
const { branchFilter } = require('../utils/branchScope');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const oid = (v) => new mongoose.Types.ObjectId(String(v && v._id ? v._id : v));
const OPEN_COMPLAINT = ['open', 'assigned', 'in_progress'];
const DUE_STATUSES = ['partial', 'credit', 'overdue'];
const TZ = 'Asia/Kolkata';

// First instant of the month `back` months before the current IST month
const monthStartIST = (back = 0) => {
  const s = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - back, 1) - IST_OFFSET_MS);
};

// Net money collected (collections minus refunds) grouped by IST month
const monthlyTransactions = (match, since) => PaymentTransaction.aggregate([
  { $match: { ...match, status: 'success', paymentDate: { $gte: since } } },
  { $group: {
      _id: { $dateToParts: { date: '$paymentDate', timezone: TZ } },
      total: { $sum: { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] } },
  } },
  { $group: { _id: { year: '$_id.year', month: '$_id.month' }, total: { $sum: '$total' } } },
  { $sort: { '_id.year': 1, '_id.month': 1 } },
]);

const netSum = (match) => PaymentTransaction.aggregate([
  { $match: { ...match, status: 'success' } },
  { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] } } } },
]).then((r) => r[0]?.total || 0);

const QUICK_ACTIONS = [
  { key: 'add_student', label: 'Add Student', to: 'students/add-student' },
  { key: 'assign_seat', label: 'Assign Seat', to: 'seats' },
  { key: 'collect_fee', label: 'Collect Fee', to: 'payments' },
  { key: 'mark_attendance', label: 'Mark Attendance', to: 'attendance' },
  { key: 'add_notice', label: 'Add Notice', to: 'notices' },
];

/**
 * Owner / staff dashboard (spec section 10): action and exception focused.
 * @param libraryId tenant id
 * @param req       optional request, used to hide financial figures from staff without `fees.view`
 */
// One $group can count many conditions at once: a single round trip instead of one per number.
const cnt = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

exports.getAdminDashboardData = async (libraryId, req = null) => {
  const libId = oid(libraryId);
  // Branch scope: {} for owners (consolidated view) / unrestricted staff; honors ?branchId= and branch-limited staff
  const scope = req ? branchFilter(req) : {};
  const now = new Date();
  const todayStart = startOfDayIST(now);
  const todayEnd = endOfDayIST(now);
  const in3 = endOfDayIST(addDaysIST(now, 3));
  const in7 = endOfDayIST(addDaysIST(now, 7));
  const in30 = endOfDayIST(addDaysIST(now, 30));
  const monthStart = monthStartIST(0);
  const sixMonthsAgo = monthStartIST(5);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const financialVisible = !req || req.userType !== 'staff' || (req.permissions || []).includes('fees.view');

  const sBase = { libraryId: libId, ...scope, isDeleted: false };
  // 9 queries instead of 17 (each one is a slow round trip on a remote database)
  const planActive = { $eq: ['$planStatus', 'active'] };
  const expiresBy = (limit) => ({ $and: [planActive, { $gte: ['$expiryDate', todayStart] }, { $lte: ['$expiryDate', limit] }] });
  const [
    studentAgg,
    attendedToday, insideNow,
    seatStats,
    enquiryAgg, newEnquiriesList,
    complaintAgg,
    expiringList,
    library,
  ] = await Promise.all([
    Student.aggregate([{ $match: sBase }, { $group: {
      _id: null,
      total: { $sum: 1 },
      active: cnt({ $and: [{ $eq: ['$status', 'active'] }, planActive] }),
      trial: cnt({ $eq: ['$planStatus', 'none'] }),
      expiring3: cnt(expiresBy(in3)),
      expiring7: cnt(expiresBy(in7)),
      expiring30: cnt(expiresBy(in30)),
      expired: cnt({ $eq: ['$planStatus', 'expired'] }),
    } }]),
    Attendance.distinct('studentId', { libraryId: libId, ...scope, date: { $gte: todayStart, $lte: todayEnd }, status: 'present' }),
    Attendance.countDocuments({ libraryId: libId, ...scope, open: true }),
    Seat.aggregate([
      { $match: { libraryId: libId, ...scope, isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Enquiry.aggregate([{ $match: { libraryId: libId, ...scope, status: 'new' } },
      { $group: { _id: null, n: { $sum: 1 }, stale: cnt({ $lte: ['$createdAt', dayAgo] }) } }]),
    Enquiry.find({ libraryId: libId, ...scope, status: 'new' }).sort({ createdAt: -1 }).limit(5).select('name mobile source createdAt').lean(),
    Complaint.aggregate([{ $match: { libraryId: libId, ...scope, status: { $in: OPEN_COMPLAINT } } },
      { $group: { _id: null, n: { $sum: 1 }, urgent: cnt({ $eq: ['$priority', 'urgent'] }) } }]),
    Student.find({ ...sBase, planStatus: 'active', expiryDate: { $gte: todayStart, $lte: in7 } })
      .sort({ expiryDate: 1 }).limit(10).select('name mobile expiryDate seatNumber').lean(),
    Library.findById(libId).select('name status subscriptionExpiry trialEndsAt subscriptionIsTrial subscriptionPlanId planLimits seatCapacity').populate('subscriptionPlanId', 'graceDays name'),
  ]);

  const st = studentAgg[0] || {};
  const totalStudents = st.total || 0, activeStudents = st.active || 0, trialStudents = st.trial || 0;
  const expiring3 = st.expiring3 || 0, expiring7 = st.expiring7 || 0, expiring30 = st.expiring30 || 0, expiredMemberships = st.expired || 0;
  const newEnquiries = enquiryAgg[0]?.n || 0, staleEnquiries = enquiryAgg[0]?.stale || 0;
  const openComplaints = complaintAgg[0]?.n || 0, urgentComplaints = complaintAgg[0]?.urgent || 0;

  const seats = { total: 0, available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 };
  seatStats.forEach((s) => { seats[s._id] = s.count; seats.total += s.count; });
  const occupancyRate = seats.total ? Math.round((seats.occupied / seats.total) * 1000) / 10 : 0;

  // Financial block (hidden for staff without fees.view)
  let fees = null, today = { attendance: attendedToday.length, insideNow, collection: null };
  let recentPayments = [], monthlyCollection = [], collectedThisMonth = null, overdue = { count: 0, amount: 0 };
  if (financialVisible) {
    const [todayCollection, pending, overdueAgg, recent, monthly, monthCollected] = await Promise.all([
      netSum({ libraryId: libId, ...scope, paymentDate: { $gte: todayStart, $lte: todayEnd } }),
      Payment.aggregate([
        { $match: { libraryId: libId, ...scope, paymentStatus: { $in: DUE_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$dueAmount' }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { libraryId: libId, ...scope, paymentStatus: { $in: DUE_STATUSES }, dueAmount: { $gt: 0 }, dueDate: { $lt: todayStart } } },
        { $group: { _id: null, total: { $sum: '$dueAmount' }, count: { $sum: 1 } } },
      ]),
      PaymentTransaction.find({ libraryId: libId, ...scope, type: 'collection', status: 'success' })
        .sort({ paymentDate: -1, createdAt: -1 }).limit(5).populate('studentId', 'name mobile').lean(),
      monthlyTransactions({ libraryId: libId, ...scope }, sixMonthsAgo),
      netSum({ libraryId: libId, ...scope, paymentDate: { $gte: monthStart } }),
    ]);
    today.collection = todayCollection;
    fees = { pendingTotal: pending[0]?.total || 0, pendingCount: pending[0]?.count || 0 };
    overdue = { count: overdueAgg[0]?.count || 0, amount: overdueAgg[0]?.total || 0 };
    recentPayments = recent;
    monthlyCollection = monthly;
    collectedThisMonth = monthCollected;
  }

  const subscription = library ? getSubscriptionState(library) : null;

  // ── Alerts requiring owner action ──
  const alerts = [];
  const alert = (type, severity, message, count, to) => alerts.push({ type, severity, message, count, to });
  if (overdue.count > 0) alert('overdue_fees', 'danger', `${overdue.count} overdue payment${overdue.count > 1 ? 's' : ''} totalling Rs ${overdue.amount}`, overdue.count, 'payments');
  if (urgentComplaints > 0) alert('urgent_complaints', 'danger', `${urgentComplaints} urgent complaint${urgentComplaints > 1 ? 's' : ''} need attention`, urgentComplaints, 'complaints');
  if (expiring3 > 0) alert('expiring_soon', 'warning', `${expiring3} membership${expiring3 > 1 ? 's' : ''} expire within 3 days`, expiring3, 'students');
  if (expiredMemberships > 0) alert('expired_memberships', 'warning', `${expiredMemberships} expired membership${expiredMemberships > 1 ? 's' : ''} awaiting renewal`, expiredMemberships, 'students');
  if (staleEnquiries > 0) alert('stale_enquiries', 'warning', `${staleEnquiries} new enquir${staleEnquiries > 1 ? 'ies are' : 'y is'} waiting for a response for over 24 hours`, staleEnquiries, 'enquiries');
  if (seats.maintenance + seats.blocked > 0) alert('seats_unavailable', 'info', `${seats.maintenance + seats.blocked} seat(s) blocked or under maintenance`, seats.maintenance + seats.blocked, 'seats');
  const maxStudents = library?.planLimits?.maxStudents;
  if (!Object.keys(scope).length && maxStudents > 0 && totalStudents >= maxStudents * 0.9) { // plan limits are library-wide
    alert('plan_limit', totalStudents >= maxStudents ? 'danger' : 'warning', `Student limit ${totalStudents}/${maxStudents} of your plan`, totalStudents, 'settings/plan');
  }
  if (subscription) {
    if (subscription.state === 'expired') alert('subscription_expired', 'danger', 'Your subscription has expired', 1, 'settings/plan');
    else if (subscription.state === 'grace') alert('subscription_grace', 'danger', `Subscription expired - ${subscription.graceDaysLeft} grace day(s) left`, 1, 'settings/plan');
    else if (subscription.daysLeft !== null && subscription.daysLeft <= 7) {
      alert('subscription_expiring', 'warning', `${subscription.state === 'trial' ? 'Trial' : 'Subscription'} ends in ${subscription.daysLeft} day(s)`, 1, 'settings/plan');
    }
  }
  const rank = { danger: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // ── Business health ──
  const activeBase = activeStudents + expiredMemberships;
  const retentionRate = activeBase ? Math.round((activeStudents / activeBase) * 1000) / 10 : 100;
  let collectionEfficiency = null;
  if (financialVisible && collectedThisMonth !== null) {
    const denom = collectedThisMonth + (fees?.pendingTotal || 0);
    collectionEfficiency = denom > 0 ? Math.round((collectedThisMonth / denom) * 1000) / 10 : 100;
  }
  const parts = [occupancyRate, retentionRate, ...(collectionEfficiency !== null ? [collectionEfficiency] : [])];
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  const businessHealth = {
    score,
    status: score >= 75 ? 'healthy' : score >= 50 ? 'needs_attention' : 'at_risk',
    occupancyRate, retentionRate, collectionEfficiency,
    renewalsDue7Days: expiring7,
    activeMembers: activeStudents,
  };

  return {
    financialVisible,
    students: { total: totalStudents, active: activeStudents, trial: trialStudents, expiringIn7Days: expiring7, expiringIn30Days: expiring30, expired: expiredMemberships },
    today,
    fees,
    collectedThisMonth,
    overdue: financialVisible ? overdue : null,
    seats: { ...seats, occupancyRate },
    expiringMemberships: { count: expiring7, items: expiringList },
    enquiries: { new: newEnquiries, latest: newEnquiriesList },
    complaints: { open: openComplaints, urgent: urgentComplaints },
    recentPayments,
    monthlyCollection,
    alerts,
    businessHealth,
    quickActions: QUICK_ACTIONS,
    subscription,
  };
};

/** Platform dashboard (superadmin only). */
exports.getSuperAdminDashboardData = async () => {
  const now = new Date();
  const sixMonthsAgo = monthStartIST(5);
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const monthStart = monthStartIST(0);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const live = { isDeleted: false };

  // Library counts, student counts and payment counts each come from one $group (14 queries became 5)
  const taxable = { $ifNull: ['$taxableAmount', '$amount'] };
  const subEnd = { $ifNull: ['$subscriptionExpiry', '$trialEndsAt'] };
  const subOn = (extra) => ({ $and: [{ $eq: ['$status', 'active'] }, ...extra] });
  const [
    libraryAgg, studentAgg, paymentCountAgg, occupiedSeatsAgg,
    tenantCollections, monthlyRevenue, libraryTrend,
    recentRegistrations, pendingApprovals,
    mrrAgg, subRevenueAgg, subRevenueMonth, subscriptionTrend,
  ] = await Promise.all([
    Library.aggregate([{ $match: live }, { $group: {
      _id: null,
      total: { $sum: 1 },
      active: cnt({ $eq: ['$status', 'active'] }),
      pending: cnt({ $eq: ['$status', 'pending'] }),
      suspended: cnt({ $eq: ['$status', 'suspended'] }),
      rejected: cnt({ $eq: ['$status', 'rejected'] }),
      // trial libraries have no subscriptionExpiry, only trialEndsAt: use whichever applies
      expiringSoon: cnt(subOn([{ $gte: [subEnd, now] }, { $lte: [subEnd, in7] }])),
      // a missing end date is not "expired": compare only when a date exists
      expiredSubs: cnt(subOn([{ $gt: [subEnd, null] }, { $lt: [subEnd, now] }])),
    } }]),
    Student.aggregate([{ $match: { isDeleted: false } }, { $group: {
      _id: null,
      total: { $sum: 1 },
      active: cnt({ $and: [{ $eq: ['$status', 'active'] }, { $eq: ['$planStatus', 'active'] }] }),
    } }]),
    PlatformPayment.aggregate([{ $group: {
      _id: null,
      failed: cnt({ $and: [{ $eq: ['$status', 'failed'] }, { $gte: ['$createdAt', thirtyDaysAgo] }] }),
      grace: cnt({ $and: [{ $eq: ['$inGrace', true] }, { $gte: ['$graceUntil', now] }] }),
    } }]),
    Seat.aggregate([{ $match: { status: 'occupied', isDeleted: false } }, { $count: 'total' }]),
    netSum({}),
    monthlyTransactions({}, sixMonthsAgo),
    Library.aggregate([
      { $match: { isDeleted: false, createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { $dateToParts: { date: '$createdAt', timezone: TZ } }, count: { $sum: 1 } } },
      { $group: { _id: { year: '$_id.year', month: '$_id.month' }, count: { $sum: '$count' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
    Library.find(live).sort({ createdAt: -1 }).limit(10)
      .select('name ownerName status city state createdAt subscriptionPlan createdBy').lean(),
    Library.find({ ...live, status: 'pending' }).sort({ createdAt: 1 }).limit(10)
      .select('name ownerName mobile email city state createdAt').lean(),
    // MRR: same rule as the Revenue page (running paying subscriptions, before GST)
    require('./revenue.service').getMrrSummary(),
    // Subscription revenue is reported before GST (GST is passed on to the government, it is not income)
    PlatformPayment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: taxable }, gross: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    PlatformPayment.aggregate([{ $match: { status: 'paid', paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: taxable } } }]),
    PlatformPayment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { $dateToParts: { date: '$paidAt', timezone: TZ } }, total: { $sum: taxable } } },
      { $group: { _id: { year: '$_id.year', month: '$_id.month' }, total: { $sum: '$total' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
  ]);

  const la = libraryAgg[0] || {}, sa = studentAgg[0] || {}, pa = paymentCountAgg[0] || {};
  const totalLibraries = la.total || 0, activeLibraries = la.active || 0, pendingLibraries = la.pending || 0;
  const suspendedLibraries = la.suspended || 0, rejectedLibraries = la.rejected || 0;
  const expiringSoon = la.expiringSoon || 0, expiredSubs = la.expiredSubs || 0;
  const totalStudents = sa.total || 0, activeMemberships = sa.active || 0;
  const failedPayments = pa.failed || 0, graceCount = pa.grace || 0;

  const label = (r) => `${MONTHS[r._id.month - 1]} ${r._id.year}`;
  const alerts = [];
  if (pendingLibraries > 0) alerts.push({ type: 'pending_approvals', severity: 'warning', message: `${pendingLibraries} library registration(s) awaiting approval`, count: pendingLibraries });
  if (failedPayments > 0) alerts.push({ type: 'failed_payments', severity: 'danger', message: `${failedPayments} failed subscription payment(s) in the last 30 days`, count: failedPayments });
  if (expiredSubs > 0) alerts.push({ type: 'expired_subscriptions', severity: 'danger', message: `${expiredSubs} active librar${expiredSubs > 1 ? 'ies have' : 'y has'} an expired subscription`, count: expiredSubs });
  if (graceCount > 0) alerts.push({ type: 'in_grace', severity: 'warning', message: `${graceCount} librar${graceCount > 1 ? 'ies are' : 'y is'} in a payment grace period`, count: graceCount });
  if (expiringSoon > 0) alerts.push({ type: 'expiring_subscriptions', severity: 'warning', message: `${expiringSoon} subscription(s) expire within 7 days`, count: expiringSoon });

  return {
    libraries: { total: totalLibraries, active: activeLibraries, pending: pendingLibraries, suspended: suspendedLibraries, rejected: rejectedLibraries },
    totalStudents,
    activeStudents: activeMemberships,
    activeMemberships,
    // legacy key: money collected by libraries from their students (all tenants)
    totalRevenue: tenantCollections,
    occupiedSeats: occupiedSeatsAgg[0]?.total || 0,
    subscriptions: {
      estimatedMRR: mrrAgg.mrr || 0,
      payingLibraries: mrrAgg.payingLibraries || 0,
      revenueTotal: subRevenueAgg[0]?.total || 0,
      grossReceivedTotal: subRevenueAgg[0]?.gross || 0,
      paymentsCount: subRevenueAgg[0]?.count || 0,
      revenueThisMonth: subRevenueMonth[0]?.total || 0,
      failedPayments30d: failedPayments,
      inGrace: graceCount,
      expiringIn7Days: expiringSoon,
      expired: expiredSubs,
      trend: subscriptionTrend.map((r) => ({ label: label(r), total: r.total })),
    },
    recentRegistrations,
    recentLibraries: recentRegistrations.slice(0, 5),
    pendingApprovals,
    alerts,
    monthlyRevenue: monthlyRevenue.map((r) => ({ label: label(r), total: r.total })),
    libraryTrend: libraryTrend.map((r) => ({ label: label(r), count: r.count })),
  };
};
