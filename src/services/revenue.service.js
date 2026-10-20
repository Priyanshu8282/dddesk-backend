/**
 * Platform revenue & monetization (super admin).
 * "Revenue" here is what libraries pay DDdesk for their SaaS subscription (PlatformPayment), NOT the fees
 * that libraries collect from their own students.
 *
 * Built for a distant database: the overview needs 5 round trips, all in parallel.
 */
const mongoose = require('mongoose');
const PlatformPayment = require('../models/platformPayment.model');
const PlatformPlan = require('../models/platformPlan.model');
const Library = require('../models/library.model');
const escapeRegex = require('../utils/escapeRegex');
const { getSubscriptionState } = require('./subscriptionState.service');
const { planPrice, round2, SUSPEND_REASON } = require('../utils/subscriptionLifecycle');
const { IST_OFFSET_MS, DAY_MS } = require('../utils/time');

const TZ = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ALLOWED_RANGES = [3, 6, 12, 24];

// First instant of the IST month `back` months before (negative = ahead) the current IST month
const monthStartIST = (back = 0) => {
  const s = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - back, 1) - IST_OFFSET_MS);
};
const monthKey = (d) => {
  const s = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (key) => { const [y, m] = key.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// Legacy payments have no GST split: treat the whole amount as taxable
const taxableExpr = { $ifNull: ['$taxableAmount', '$amount'] };
const gstExpr = { $ifNull: ['$gstAmount', 0] };

/** GST-inclusive monthly equivalent a library pays right now (annual plans / 12) */
const monthlyEquivalent = (plan, cycle) => {
  if (!plan) return 0;
  const price = cycle === 'annual' ? planPrice(plan, 'annual') / 12 : planPrice(plan, 'monthly');
  return price;
};
const withGst = (v, pct) => round2(v * (1 + (Number.isFinite(Number(pct)) ? Number(pct) : 18) / 100));

exports.RANGES = ALLOWED_RANGES;

exports.getOverview = async ({ months = 12 } = {}) => {
  const range = ALLOWED_RANGES.includes(Number(months)) ? Number(months) : 12;
  const from = monthStartIST(range - 1);
  const now = new Date();

  const [paidFacet, otherAgg, libs, plans] = await Promise.all([
    PlatformPayment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: from } } },
      { $facet: {
        totals: [{ $group: { _id: null, total: { $sum: '$amount' }, taxable: { $sum: taxableExpr }, gst: { $sum: gstExpr }, count: { $sum: 1 } } }],
        monthly: [
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: TZ } }, total: { $sum: '$amount' }, taxable: { $sum: taxableExpr }, gst: { $sum: gstExpr }, count: { $sum: 1 } } },
        ],
        byPlan: [{ $group: { _id: '$platformPlanId', revenue: { $sum: '$amount' }, count: { $sum: 1 } } }],
        byCycle: [{ $group: { _id: '$period', revenue: { $sum: '$amount' }, count: { $sum: 1 } } }],
        byKind: [{ $group: { _id: '$kind', revenue: { $sum: '$amount' }, count: { $sum: 1 } } }],
        topLibraries: [
          { $group: { _id: '$libraryId', paid: { $sum: '$amount' }, payments: { $sum: 1 }, last: { $max: '$paidAt' } } },
          { $sort: { paid: -1 } }, { $limit: 5 },
        ],
      } },
    ]),
    PlatformPayment.aggregate([
      { $match: { status: { $in: ['failed', 'pending'] }, createdAt: { $gte: from } } },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    Library.find({ isDeleted: false, status: { $in: ['active', 'suspended'] } })
      .select('name status statusReason subscriptionPlanId subscriptionPlan subscriptionExpiry trialEndsAt subscriptionIsTrial subscriptionStatus billingCycle createdAt')
      .lean(),
    PlatformPlan.find({ isDeleted: false }).select('name monthlyPrice annualPrice gstPercent graceDays isActive').lean(),
  ]);

  const facet = paidFacet[0] || {};
  const planById = new Map(plans.map((p) => [String(p._id), p]));
  const libName = new Map(libs.map((l) => [String(l._id), l.name]));

  // ---- monthly trend (every month in range, zero-filled) ----
  const byMonth = new Map((facet.monthly || []).map((r) => [r._id, r]));
  const trend = [];
  for (let i = range - 1; i >= 0; i--) {
    const key = monthKey(monthStartIST(i));
    const r = byMonth.get(key) || {};
    trend.push({ key, label: monthLabel(key), total: round2(r.total || 0), taxable: round2(r.taxable || 0), gst: round2(r.gst || 0), count: r.count || 0 });
  }
  const thisMonth = trend[trend.length - 1]?.total || 0;
  const lastMonth = trend[trend.length - 2]?.total || 0;
  const growthPct = lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : (thisMonth > 0 ? null : 0);

  // ---- libraries: subscription states, MRR, upcoming renewals, at risk ----
  const states = { trial: 0, active: 0, grace: 0, expired: 0, noPlan: 0 };
  const perPlan = new Map(); // planId -> { libraries, mrr }
  const upcoming = [];
  const atRisk = [];
  let mrr = 0, payingLibraries = 0;
  const horizon = new Date(now.getTime() + 30 * DAY_MS);
  const forecastBuckets = new Map(); // YYYY-MM -> expected GST-inclusive revenue (next 3 calendar months)
  const forecastKeys = [1, 2, 3].map((n) => monthKey(monthStartIST(-n)));
  forecastKeys.forEach((k) => forecastBuckets.set(k, 0));
  const thisKey = monthKey(now);
  forecastBuckets.set(thisKey, 0);

  for (const lib of libs) {
    const plan = lib.subscriptionPlanId ? planById.get(String(lib.subscriptionPlanId)) : null;
    const st = getSubscriptionState(lib, plan, now);
    if (lib.status === 'suspended') {
      if (lib.statusReason === SUSPEND_REASON) {
        states.expired++;
        atRisk.push({
          libraryId: lib._id, name: lib.name, plan: lib.subscriptionPlan || '-', state: 'suspended',
          endedOn: st.expiresAt, graceEndsOn: st.graceEndsAt,
          daysOverdue: st.expiresAt ? Math.max(0, Math.floor((now - new Date(st.expiresAt)) / DAY_MS)) : null,
          amountDue: plan ? withGst(planPrice(plan, lib.billingCycle || 'monthly'), plan.gstPercent) : 0,
        });
      }
      continue;
    }
    if (!plan) { states.noPlan++; continue; }

    const isTrial = st.state === 'trial';
    if (st.state === 'trial') states.trial++;
    else if (st.state === 'grace') states.grace++;
    else if (st.state === 'expired') states.expired++;
    else states.active++;

    const cycle = lib.billingCycle || 'monthly';
    const bucket = perPlan.get(String(plan._id)) || { libraries: 0, mrr: 0 };
    bucket.libraries++;
    if (!isTrial && st.state !== 'expired' && planPrice(plan, 'monthly') > 0) {
      const eq = withGst(monthlyEquivalent(plan, cycle), plan.gstPercent);
      mrr += eq; bucket.mrr += eq; payingLibraries++;
    }
    perPlan.set(String(plan._id), bucket);

    if (st.state === 'grace') {
      atRisk.push({
        libraryId: lib._id, name: lib.name, plan: plan.name, state: 'grace', endedOn: st.expiresAt, graceEndsOn: st.graceEndsAt,
        daysOverdue: Math.max(0, Math.floor((now - new Date(st.expiresAt)) / DAY_MS)), graceDaysLeft: st.graceDaysLeft,
        amountDue: withGst(planPrice(plan, cycle), plan.gstPercent),
      });
    }
    const exp = st.expiresAt ? new Date(st.expiresAt) : null;
    if (exp && exp >= now && exp <= horizon) {
      upcoming.push({
        libraryId: lib._id, name: lib.name, plan: plan.name, cycle, isTrial, expiresOn: exp,
        daysLeft: Math.max(0, Math.ceil((exp - now) / DAY_MS)),
        expectedAmount: withGst(planPrice(plan, cycle), plan.gstPercent),
      });
    }

    // forecast: monthly libraries pay every month; annual ones once at their renewal month
    if (!isTrial && st.state !== 'expired' && planPrice(plan, 'monthly') > 0) {
      for (const k of [thisKey, ...forecastKeys]) {
        if (cycle === 'annual') {
          if (exp && monthKey(exp) === k) forecastBuckets.set(k, forecastBuckets.get(k) + withGst(planPrice(plan, 'annual'), plan.gstPercent));
        } else if (k !== thisKey || (exp && exp >= now && monthKey(exp) === thisKey)) {
          forecastBuckets.set(k, forecastBuckets.get(k) + withGst(planPrice(plan, 'monthly'), plan.gstPercent));
        }
      }
    }
  }
  upcoming.sort((a, b) => a.expiresOn - b.expiresOn);
  atRisk.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));

  // ---- breakdowns ----
  const revenueByPlan = new Map((facet.byPlan || []).map((r) => [String(r._id), r]));
  const planIds = new Set([...revenueByPlan.keys(), ...perPlan.keys()]);
  const totalPlanRevenue = [...revenueByPlan.values()].reduce((s, r) => s + r.revenue, 0) || 0;
  const byPlan = [...planIds].map((id) => {
    const p = planById.get(id); const r = revenueByPlan.get(id) || {}; const l = perPlan.get(id) || {};
    return {
      planId: id, name: p ? p.name : 'Archived plan', revenue: round2(r.revenue || 0), payments: r.count || 0,
      libraries: l.libraries || 0, mrr: round2(l.mrr || 0),
      sharePct: totalPlanRevenue ? round2(((r.revenue || 0) / totalPlanRevenue) * 100) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue || b.mrr - a.mrr);

  const other = Object.fromEntries(otherAgg.map((r) => [r._id, r]));
  const totals = (facet.totals && facet.totals[0]) || { total: 0, taxable: 0, gst: 0, count: 0 };
  const failedCount = other.failed?.count || 0;

  return {
    range: { months: range, from, to: now },
    kpis: {
      collected: { total: round2(totals.total), taxable: round2(totals.taxable), gst: round2(totals.gst), count: totals.count, avgInvoice: totals.count ? round2(totals.total / totals.count) : 0 },
      thisMonth, lastMonth, growthPct,
      mrr: round2(mrr), arr: round2(mrr * 12),
      arpu: payingLibraries ? round2(mrr / payingLibraries) : 0,
      payingLibraries,
      libraries: { ...states, total: libs.length },
      failed: { count: failedCount, amount: round2(other.failed?.amount || 0) },
      pending: { count: other.pending?.count || 0, amount: round2(other.pending?.amount || 0) },
      // share of attempted payments that succeeded
      successRatePct: totals.count + failedCount ? round2((totals.count / (totals.count + failedCount)) * 100) : null,
      atRiskAmount: round2(atRisk.reduce((s, r) => s + (r.amountDue || 0), 0)),
    },
    trend,
    forecast: [thisKey, ...forecastKeys].map((k) => ({ key: k, label: monthLabel(k), expected: round2(forecastBuckets.get(k) || 0), isCurrent: k === thisKey })),
    byPlan,
    byCycle: (facet.byCycle || []).map((r) => ({ cycle: r._id || 'monthly', revenue: round2(r.revenue), payments: r.count })),
    byKind: (facet.byKind || []).map((r) => ({ kind: r._id || 'renewal', revenue: round2(r.revenue), payments: r.count })),
    topLibraries: (facet.topLibraries || []).map((r) => ({ libraryId: r._id, name: libName.get(String(r._id)) || 'Removed library', paid: round2(r.paid), payments: r.payments, lastPaidAt: r.last })),
    upcomingRenewals: upcoming.slice(0, 15),
    upcomingTotal: round2(upcoming.reduce((s, r) => s + r.expectedAmount, 0)),
    atRisk: atRisk.slice(0, 15),
    generatedAt: now,
  };
};

// ---------------------------------------------------------------------------
// Payments list + export
// ---------------------------------------------------------------------------
const buildFilter = async (q = {}) => {
  const filter = {};
  if (q.status && q.status !== 'all') filter.status = String(q.status);
  if (q.planId && mongoose.isValidObjectId(q.planId)) filter.platformPlanId = oid(q.planId);
  if (q.period === 'monthly' || q.period === 'annual') filter.period = q.period;
  if (q.libraryId && mongoose.isValidObjectId(q.libraryId)) filter.libraryId = oid(q.libraryId);
  const dateField = filter.status === 'paid' || q.status === 'paid' ? 'paidAt' : 'createdAt';
  const range = {};
  if (q.from) { const d = new Date(`${q.from}T00:00:00+05:30`); if (!isNaN(d)) range.$gte = d; }
  if (q.to) { const d = new Date(`${q.to}T23:59:59.999+05:30`); if (!isNaN(d)) range.$lte = d; }
  if (Object.keys(range).length) filter[dateField] = range;
  if (q.q && String(q.q).trim()) {
    const re = new RegExp(escapeRegex(String(q.q).trim()), 'i');
    const libs = await Library.find({ $or: [{ name: re }, { libraryCode: re }, { ownerName: re }] }).select('_id').limit(200).lean();
    filter.$or = [{ invoiceNo: re }, { razorpayPaymentId: re }, { razorpayOrderId: re }, { libraryId: { $in: libs.map((l) => l._id) } }];
  }
  return filter;
};

const shape = (p) => ({
  _id: p._id,
  library: p.libraryId ? { _id: p.libraryId._id || p.libraryId, name: p.libraryId.name || 'Removed library', code: p.libraryId.libraryCode || null } : null,
  plan: p.platformPlanId ? (p.platformPlanId.name || null) : null,
  period: p.period, kind: p.kind, status: p.status,
  taxable: p.taxableAmount != null ? p.taxableAmount : p.amount,
  gstPercent: p.gstPercent != null ? p.gstPercent : 0, gst: p.gstAmount || 0, total: p.amount,
  creditApplied: p.creditApplied || 0,
  invoiceNo: p.invoiceNo || null, razorpayPaymentId: p.razorpayPaymentId || null, failureReason: p.failureReason || null,
  periodStart: p.periodStart || null, periodEnd: p.periodEnd || null, paidAt: p.paidAt || null, createdAt: p.createdAt,
});

exports.listPayments = async (q = {}) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 15));
  const filter = await buildFilter(q);
  const sortField = filter.status === 'paid' ? { paidAt: -1, _id: -1 } : { createdAt: -1, _id: -1 };
  const [rows, total, sums] = await Promise.all([
    PlatformPayment.find(filter).sort(sortField).skip((page - 1) * limit).limit(limit)
      .populate('libraryId', 'name libraryCode').populate('platformPlanId', 'name').lean(),
    PlatformPayment.countDocuments(filter),
    PlatformPayment.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' }, taxable: { $sum: taxableExpr }, gst: { $sum: gstExpr } } }]),
  ]);
  const s = sums[0] || { total: 0, taxable: 0, gst: 0 };
  return {
    data: rows.map(shape), total, page, limit, totalPages: Math.ceil(total / limit),
    // totals of the WHOLE filtered set, not just this page
    summary: { total: round2(s.total || 0), taxable: round2(s.taxable || 0), gst: round2(s.gst || 0) },
  };
};

// CSV cells starting with = + - @ would be run as formulas by spreadsheets: prefix them
const csvCell = (v) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

exports.exportCsv = async (q, write) => {
  const filter = await buildFilter(q);
  const head = ['Invoice no', 'Status', 'Library', 'Library code', 'Plan', 'Billing', 'Type', 'Taxable (INR)', 'GST %', 'GST (INR)', 'Total (INR)', 'Credit applied (INR)', 'Paid on', 'Created on', 'Period start', 'Period end', 'Razorpay payment', 'Failure reason'];
  await write('﻿' + head.map(csvCell).join(',') + '\n');
  const cursor = PlatformPayment.find(filter).sort({ createdAt: -1, _id: -1 }).limit(50000)
    .populate('libraryId', 'name libraryCode').populate('platformPlanId', 'name').lean().cursor();
  let n = 0;
  for await (const doc of cursor) {
    const r = shape(doc);
    await write([r.invoiceNo, r.status, r.library?.name, r.library?.code, r.plan, r.period, r.kind, r.taxable, r.gstPercent, r.gst, r.total, r.creditApplied, r.paidAt, r.createdAt, r.periodStart, r.periodEnd, r.razorpayPaymentId, r.failureReason].map(csvCell).join(',') + '\n');
    n++;
  }
  return n;
};
