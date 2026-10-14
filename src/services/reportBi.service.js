// Business-intelligence functions: trends, pipelines, health score and action lists.
// Every function takes a tenant ObjectId (already cast) and a parsed query (see reportQuery.parseQuery).
const Payment = require('../models/payment.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Attendance = require('../models/attendance.model');
const Enquiry = require('../models/enquiry.model');
const SeatHistory = require('../models/seatHistory.model');
const { startOfDayIST, endOfDayIST, addDaysIST, istDateKey, toISTString } = require('../utils/time');
const { requireRange, branchCond, round1, pct, istDayExpr } = require('./reportQuery');

const NON_LIVE = ['cancelled', 'waived', 'refunded'];
const EFFECTIVE_DATE = { $ifNull: ['$paymentDate', '$createdAt'] };
const MAX_ASSIGNED_SCAN = 20000;

const dayKeys = (start, end) => {
    const out = [];
    for (let t = startOfDayIST(start).getTime(); t <= end.getTime(); t += 86400000) out.push(istDateKey(new Date(t)));
    return out;
};
const monthKeys = (start, end) => {
    const out = [];
    const seen = new Set();
    for (let t = startOfDayIST(start).getTime(); t <= end.getTime(); t += 86400000 * 7) {
        const k = istDateKey(new Date(t)).slice(0, 7);
        if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    const last = istDateKey(end).slice(0, 7);
    if (!seen.has(last)) out.push(last);
    return out;
};

const periodOf = (p, granularity) => {
    if (granularity === 'month') return { fmt: '%Y-%m', keys: monthKeys(p.start, p.end) };
    return { fmt: '%Y-%m-%d', keys: dayKeys(p.start, p.end) };
};

const gran = (p) => (p.granularity === 'month' ? 'month' : 'day');

// ---------------------------------------------------------------- occupancy
const OCC_DELTA = { assigned: 1, transfer_in: 1, released: -1, auto_released: -1, transfer_out: -1 };

// Rebuild daily occupied-seat counts from SeatHistory events. Returns null when history is missing or inconsistent.
const occupancyFromSeatHistory = async (L, p, keys, currentOccupied) => {
    const rows = await SeatHistory.aggregate([
        { $match: { libraryId: L, ...branchCond(p), action: { $in: Object.keys(OCC_DELTA) }, at: { $lte: p.end } } },
        { $group: { _id: { d: istDayExpr('$at'), a: '$action' }, n: { $sum: 1 } } }
    ]);
    if (!rows.length) return null;
    const perDay = new Map();
    rows.forEach((r) => perDay.set(r._id.d, (perDay.get(r._id.d) || 0) + OCC_DELTA[r._id.a] * r.n));
    const startKey = istDateKey(p.start);
    let level = 0;
    [...perDay.entries()].filter(([d]) => d < startKey).forEach(([, v]) => { level += v; });
    const out = new Map();
    keys.forEach((k) => { level += perDay.get(k) || 0; out.set(k, Math.max(0, level)); });
    // The last reconstructed day must agree with today's seat map, otherwise the history is incomplete
    const endKey = istDateKey(p.end);
    const todayKey = istDateKey(new Date());
    if (endKey >= todayKey && out.get(keys[keys.length - 1]) !== currentOccupied) return null;
    return out;
};
exports.occupancyTrend = async (L, p) => {
    requireRange(p, 92);
    const keys = dayKeys(p.start, p.end);
    const [bookable, attRows, students, seatNow] = await Promise.all([
        Seat.countDocuments({ libraryId: L, ...branchCond(p), status: { $nin: ['blocked', 'maintenance'] } }),
        Attendance.aggregate([
            { $match: { libraryId: L, ...branchCond(p), checkIn: { $gte: p.start, $lte: p.end } } },
            { $group: { _id: { d: istDayExpr('$checkIn'), s: '$studentId' } } },
            { $group: { _id: '$_id.d', students: { $sum: 1 } } }
        ]),
        Student.find({ libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, seatId: { $ne: null } })
            .select('joiningDate createdAt expiryDate').limit(MAX_ASSIGNED_SCAN).lean(),
        Seat.countDocuments({ libraryId: L, ...branchCond(p), status: 'occupied' })
    ]);
    const att = new Map(attRows.map((r) => [r._id, r.students]));
    const hist = await occupancyFromSeatHistory(L, p, keys, seatNow);
    const spans = students.map((s) => ({
        from: (s.joiningDate || s.createdAt || new Date(0)).getTime(),
        to: s.expiryDate ? s.expiryDate.getTime() : Infinity
    }));
    const series = keys.map((k) => {
        const ds = startOfDayIST(k).getTime();
        const de = ds + 86400000 - 1;
        const assigned = hist ? hist.get(k) : spans.reduce((n, s) => (s.from <= de && s.to >= ds ? n + 1 : n), 0);
        const present = att.get(k) || 0;
        return {
            date: k, assignedStudents: assigned, assignedOccupancyPct: pct(Math.min(assigned, bookable), bookable),
            attendanceStudents: present, attendanceUtilizationPct: pct(Math.min(present, bookable), bookable)
        };
    });
    return {
        range: { start: istDateKey(p.start), end: istDateKey(p.end) },
        bookableSeats: bookable,
        current: { occupiedSeats: seatNow, occupancyPct: pct(seatNow, bookable) },
        series,
        dataQuality: {
            method: hist
                ? 'assignedOccupancyPct is rebuilt from SeatHistory assignment/release events; attendanceUtilizationPct is distinct students checked in per IST day.'
                : 'SeatHistory is empty or incomplete for this range. assignedOccupancyPct is derived from the membership dates (joining to expiry) of students who currently hold a seat; attendanceUtilizationPct is distinct students checked in per IST day.',
            source: hist ? 'seatHistory' : 'membershipDates',
            approximate: !hist,
            truncated: students.length >= MAX_ASSIGNED_SCAN,
            hasAttendanceData: attRows.length > 0
        }
    };
};

// ---------------------------------------------------------------- revenue
exports.revenueTrend = async (L, p) => {
    const g = gran(p);
    requireRange(p);
    const { fmt, keys } = periodOf(p, g);
    const rows = await Payment.aggregate([
        { $match: { libraryId: L, ...branchCond(p), paymentStatus: { $ne: 'cancelled' }, $or: [{ paymentDate: { $gte: p.start, $lte: p.end } }, { paymentDate: null, createdAt: { $gte: p.start, $lte: p.end } }] } },
        { $group: {
            _id: { $dateToString: { format: fmt, date: EFFECTIVE_DATE, timezone: 'Asia/Kolkata' } },
            collected: { $sum: '$paidAmount' }, refunds: { $sum: '$refundAmount' }, transactions: { $sum: { $cond: [{ $gt: ['$paidAmount', 0] }, 1, 0] } },
            billed: { $sum: '$totalAmount' }
        } }
    ]);
    const m = new Map(rows.map((r) => [r._id, r]));
    const series = keys.map((k) => {
        const r = m.get(k) || {};
        return { period: k, collected: r.collected || 0, refunds: r.refunds || 0, net: (r.collected || 0) - (r.refunds || 0), transactions: r.transactions || 0, billed: r.billed || 0 };
    });
    const total = series.reduce((a, s) => ({ collected: a.collected + s.collected, refunds: a.refunds + s.refunds, net: a.net + s.net }), { collected: 0, refunds: 0, net: 0 });
    return { granularity: g, range: { start: istDateKey(p.start), end: istDateKey(p.end) }, total, series, hasData: rows.length > 0 };
};

// ---------------------------------------------------------------- renewals
exports.renewalTrend = async (L, p) => {
    requireRange(p);
    const { keys } = periodOf(p, 'month');
    const [renewals, lapsed] = await Promise.all([
        Payment.aggregate([
            { $match: { libraryId: L, ...branchCond(p), paymentType: 'renewal', paidAmount: { $gt: 0 }, paymentStatus: { $ne: 'cancelled' }, $or: [{ paymentDate: { $gte: p.start, $lte: p.end } }, { paymentDate: null, createdAt: { $gte: p.start, $lte: p.end } }] } },
            { $group: { _id: { $dateToString: { format: '%Y-%m', date: EFFECTIVE_DATE, timezone: 'Asia/Kolkata' } }, renewals: { $sum: 1 }, amount: { $sum: '$paidAmount' } } }
        ]),
        // memberships that ended in the month and were not extended (renewed students have a later expiry)
        Student.aggregate([
            { $match: { libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, expiryDate: { $gte: p.start, $lte: p.end, $lt: startOfDayIST(new Date()) } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$expiryDate', timezone: 'Asia/Kolkata' } }, lapsed: { $sum: 1 } } }
        ])
    ]);
    const rm = new Map(renewals.map((r) => [r._id, r]));
    const lm = new Map(lapsed.map((r) => [r._id, r.lapsed]));
    const series = keys.map((k) => {
        const r = rm.get(k) || { renewals: 0, amount: 0 };
        const l = lm.get(k) || 0;
        return { period: k, renewals: r.renewals, renewalAmount: r.amount, lapsed: l, renewalRatePct: r.renewals + l > 0 ? pct(r.renewals, r.renewals + l) : null };
    });
    const tr = series.reduce((a, s) => a + s.renewals, 0);
    const tl = series.reduce((a, s) => a + s.lapsed, 0);
    return { range: { start: istDateKey(p.start), end: istDateKey(p.end) }, totals: { renewals: tr, lapsed: tl, renewalRatePct: tr + tl > 0 ? pct(tr, tr + tl) : null }, series, definition: 'renewalRate = renewals / (renewals + memberships that ended without renewal)' };
};

// ---------------------------------------------------------------- outstanding fees
exports.outstandingTrend = async (L, p) => {
    requireRange(p);
    const { keys } = periodOf(p, 'month');
    const [rows, current] = await Promise.all([
        Payment.aggregate([
            { $match: { libraryId: L, ...branchCond(p), paymentStatus: { $nin: NON_LIVE }, createdAt: { $gte: p.start, $lte: p.end } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } }, billed: { $sum: '$totalAmount' }, collected: { $sum: '$paidAmount' }, outstanding: { $sum: '$dueAmount' }, accounts: { $sum: { $cond: [{ $gt: ['$dueAmount', 0] }, 1, 0] } } } }
        ]),
        Payment.aggregate([
            { $match: { libraryId: L, ...branchCond(p), paymentStatus: { $nin: NON_LIVE }, dueAmount: { $gt: 0 } } },
            { $group: { _id: null, outstanding: { $sum: '$dueAmount' }, accounts: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, '$dueAmount', 0] } } } }
        ])
    ]);
    const m = new Map(rows.map((r) => [r._id, r]));
    return {
        range: { start: istDateKey(p.start), end: istDateKey(p.end) },
        current: { outstanding: current[0]?.outstanding || 0, accounts: current[0]?.accounts || 0, overdue: current[0]?.overdue || 0 },
        series: keys.map((k) => { const r = m.get(k) || {}; return { period: k, billed: r.billed || 0, collected: r.collected || 0, outstanding: r.outstanding || 0, accountsWithDue: r.accounts || 0 }; }),
        definition: 'Per month: dues still unpaid on charges raised in that month'
    };
};

// ---------------------------------------------------------------- admissions
exports.admissionTrend = async (L, p) => {
    const g = gran(p);
    requireRange(p);
    const { fmt, keys } = periodOf(p, g);
    const rows = await Student.aggregate([
        { $match: { libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, joiningDate: { $gte: p.start, $lte: p.end } } },
        { $group: { _id: { $dateToString: { format: fmt, date: '$joiningDate', timezone: 'Asia/Kolkata' } }, admissions: { $sum: 1 } } }
    ]);
    const m = new Map(rows.map((r) => [r._id, r.admissions]));
    const series = keys.map((k) => ({ period: k, admissions: m.get(k) || 0 }));
    return { granularity: g, range: { start: istDateKey(p.start), end: istDateKey(p.end) }, total: series.reduce((a, s) => a + s.admissions, 0), series };
};

// ---------------------------------------------------------------- enquiry conversion
exports.enquiryConversion = async (L, p) => {
    requireRange(p);
    const match = { libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, createdAt: { $gte: p.start, $lte: p.end } };
    const conv = { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } };
    const [bySource, byMonth] = await Promise.all([
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$source', total: { $sum: 1 }, converted: conv } }, { $sort: { total: -1 } }]),
        Enquiry.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } }, total: { $sum: 1 }, converted: conv } }, { $sort: { _id: 1 } }])
    ]);
    const total = bySource.reduce((a, r) => a + r.total, 0);
    const converted = bySource.reduce((a, r) => a + r.converted, 0);
    return {
        range: { start: istDateKey(p.start), end: istDateKey(p.end) },
        totals: { enquiries: total, converted, conversionRatePct: pct(converted, total) },
        bySource: bySource.map((r) => ({ source: r._id || 'other', total: r.total, converted: r.converted, conversionRatePct: pct(r.converted, r.total) })),
        byMonth: byMonth.map((r) => ({ period: r._id, total: r.total, converted: r.converted, conversionRatePct: pct(r.converted, r.total) }))
    };
};

// ---------------------------------------------------------------- seat utilization
exports.seatUtilization = async (L, p) => {
    const rows = await Seat.aggregate([
        { $match: { libraryId: L, ...branchCond(p), isDeleted: { $ne: true } } },
        { $group: {
            _id: { floor: '$floor', room: '$room' }, total: { $sum: 1 },
            occupied: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } },
            reserved: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
            available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
            unavailable: { $sum: { $cond: [{ $in: ['$status', ['blocked', 'maintenance']] }, 1, 0] } }
        } },
        { $sort: { '_id.floor': 1, '_id.room': 1 } }
    ]);
    const shape = (r) => {
        const bookable = r.total - r.unavailable;
        return { total: r.total, occupied: r.occupied, reserved: r.reserved, available: r.available, unavailable: r.unavailable, utilizationPct: pct(r.occupied, bookable) };
    };
    const totals = rows.reduce((a, r) => ({ total: a.total + r.total, occupied: a.occupied + r.occupied, reserved: a.reserved + r.reserved, available: a.available + r.available, unavailable: a.unavailable + r.unavailable }), { total: 0, occupied: 0, reserved: 0, available: 0, unavailable: 0 });
    // average distinct students per day over the last 30 days vs. bookable seats
    const since = addDaysIST(new Date(), -29);
    const att = await Attendance.aggregate([
        { $match: { libraryId: L, ...branchCond(p), checkIn: { $gte: since } } },
        { $group: { _id: { d: istDayExpr('$checkIn'), s: '$studentId' } } },
        { $group: { _id: '$_id.d', students: { $sum: 1 } } }
    ]);
    const avgDaily = att.length ? round1(att.reduce((a, r) => a + r.students, 0) / att.length) : null;
    const bookable = totals.total - totals.unavailable;
    return {
        overall: shape(totals),
        byLocation: rows.map((r) => ({ floor: r._id.floor || 'Main Floor', room: r._id.room || 'Main Hall', ...shape(r) })),
        attendanceBased: { windowDays: 30, daysWithData: att.length, avgStudentsPerDay: avgDaily, avgUtilizationPct: avgDaily === null ? null : pct(avgDaily, bookable) }
    };
};

// ---------------------------------------------------------------- expiry pipeline
exports.expiryPipeline = async (L, p) => {
    const today = startOfDayIST(new Date());
    const live = { libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, status: 'active' };
    const buckets = [
        { key: 'expired', label: 'Already expired', from: addDaysIST(today, -90), to: new Date(today.getTime() - 1) },
        { key: 'next7', label: 'Expiring in 0-7 days', from: today, to: endOfDayIST(addDaysIST(today, 7)) },
        { key: 'next15', label: 'Expiring in 8-15 days', from: addDaysIST(today, 8), to: endOfDayIST(addDaysIST(today, 15)) },
        { key: 'next30', label: 'Expiring in 16-30 days', from: addDaysIST(today, 16), to: endOfDayIST(addDaysIST(today, 30)) }
    ];
    const out = await Promise.all(buckets.map(async (b) => {
        const f = { ...live, expiryDate: { $gte: b.from, $lte: b.to } };
        const [count, list] = await Promise.all([
            Student.countDocuments(f),
            Student.find(f).select('name mobile seatNumber expiryDate planId').populate('planId', 'name').sort({ expiryDate: 1 }).limit(p.listLimit || 25).lean()
        ]);
        return {
            key: b.key, label: b.label, count,
            students: list.map((s) => ({ id: s._id, name: s.name, mobile: s.mobile, seat: s.seatNumber || '', plan: s.planId?.name || '', expiryDate: istDateKey(s.expiryDate) }))
        };
    }));
    return { asOf: toISTString(new Date()), note: 'Expired bucket covers the last 90 days; list sizes are capped.', buckets: out };
};

// ---------------------------------------------------------------- health score
exports.healthScore = async (L, p) => {
    const since30 = addDaysIST(new Date(), -29);
    const since90 = addDaysIST(new Date(), -89);
    const today = startOfDayIST(new Date());
    const [seatAgg, payAgg, renewalCount, lapsedCount] = await Promise.all([
        Seat.aggregate([{ $match: { libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, status: { $nin: ['blocked', 'maintenance'] } } }, { $group: { _id: null, total: { $sum: 1 }, occupied: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } } } }]),
        Payment.aggregate([
            { $match: { libraryId: L, ...branchCond(p), paymentStatus: { $nin: NON_LIVE }, createdAt: { $gte: since30 } } },
            { $group: { _id: null, paid: { $sum: '$paidAmount' }, due: { $sum: '$dueAmount' } } }
        ]),
        Payment.countDocuments({ libraryId: L, ...branchCond(p), paymentType: 'renewal', paidAmount: { $gt: 0 }, paymentStatus: { $ne: 'cancelled' }, createdAt: { $gte: since90 } }),
        Student.countDocuments({ libraryId: L, ...branchCond(p), isDeleted: { $ne: true }, expiryDate: { $gte: since90, $lt: today } })
    ]);
    const seats = seatAgg[0];
    const pay = payAgg[0];
    const comps = [
        {
            key: 'occupancy', label: 'Seat occupancy', weight: 40,
            value: seats && seats.total > 0 ? pct(seats.occupied, seats.total) : null,
            explanation: seats ? `${seats.occupied} of ${seats.total} bookable seats are occupied.` : 'No seats configured.'
        },
        {
            key: 'collection', label: 'Fee collection rate (last 30 days)', weight: 35,
            value: pay && pay.paid + pay.due > 0 ? pct(pay.paid, pay.paid + pay.due) : null,
            explanation: pay ? `Collected INR ${pay.paid} against INR ${pay.paid + pay.due} billed on charges raised in the last 30 days.` : 'No charges raised in the last 30 days.'
        },
        {
            key: 'renewal', label: 'Renewal rate (last 90 days)', weight: 25,
            value: renewalCount + lapsedCount > 0 ? pct(renewalCount, renewalCount + lapsedCount) : null,
            explanation: renewalCount + lapsedCount > 0 ? `${renewalCount} renewals vs ${lapsedCount} memberships that ended without renewal.` : 'No memberships came up for renewal in the last 90 days.'
        }
    ];
    const available = comps.filter((c) => c.value !== null);
    const wsum = available.reduce((a, c) => a + c.weight, 0);
    const components = comps.map((c) => ({
        ...c, available: c.value !== null,
        effectiveWeightPct: c.value !== null && wsum > 0 ? round1((c.weight / wsum) * 100) : 0,
        contribution: c.value !== null && wsum > 0 ? round1((c.value * c.weight) / wsum) : 0
    }));
    const score = wsum > 0 ? Math.round(components.reduce((a, c) => a + c.contribution, 0)) : null;
    const rating = score === null ? 'Insufficient data' : score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Needs attention' : 'Critical';
    return {
        score, rating, components,
        method: 'Weighted average of available components (occupancy 40, collection 35, renewal 25). Components without data are excluded and weights are re-normalised.',
        missingComponents: comps.filter((c) => c.value === null).map((c) => c.key)
    };
};

// ---------------------------------------------------------------- action list
exports.actionList = async (L, p) => {
    const cap = Math.min(50, p.listLimit || 20);
    const today = startOfDayIST(new Date());
    const in7 = endOfDayIST(addDaysIST(today, 7));
    const live = { libraryId: L, ...branchCond(p), isDeleted: { $ne: true } };
    const overdueF = { libraryId: L, ...branchCond(p), paymentStatus: { $nin: NON_LIVE }, dueAmount: { $gt: 0 }, dueDate: { $lt: new Date() } };
    const [expCount, expList, odAgg, odList, unCount, unList, vacCount, vacList, availNow] = await Promise.all([
        Student.countDocuments({ ...live, status: 'active', expiryDate: { $gte: today, $lte: in7 } }),
        Student.find({ ...live, status: 'active', expiryDate: { $gte: today, $lte: in7 } }).select('name mobile seatNumber expiryDate').sort({ expiryDate: 1 }).limit(cap).lean(),
        Payment.aggregate([{ $match: overdueF }, { $group: { _id: null, accounts: { $sum: 1 }, amount: { $sum: '$dueAmount' } } }]),
        Payment.find(overdueF).sort({ dueAmount: -1 }).limit(cap).populate('studentId', 'name mobile seatNumber').lean(),
        Student.countDocuments({ ...live, status: 'active', planStatus: 'active', seatId: null }),
        Student.find({ ...live, status: 'active', planStatus: 'active', seatId: null }).select('name mobile planStartDate').sort({ planStartDate: -1 }).limit(cap).lean(),
        Seat.countDocuments({ libraryId: L, ...branchCond(p), status: 'occupied' }),
        Seat.find({ libraryId: L, ...branchCond(p), status: 'occupied' }).populate({ path: 'studentId', select: 'name mobile expiryDate', match: { expiryDate: { $lte: in7 } } }).limit(1000).lean(),
        Seat.countDocuments({ libraryId: L, ...branchCond(p), status: 'available' })
    ]);
    const vacant = vacList.filter((s) => s.studentId).sort((a, b) => a.studentId.expiryDate - b.studentId.expiryDate);
    return {
        asOf: toISTString(new Date()),
        actions: [
            {
                key: 'follow_up_expiring', priority: 'high', title: 'Follow up with students whose membership expires within 7 days', count: expCount,
                suggestedAction: 'Call or send a renewal reminder', items: expList.map((s) => ({ id: s._id, name: s.name, mobile: s.mobile, seat: s.seatNumber || '', expiryDate: istDateKey(s.expiryDate) }))
            },
            {
                key: 'overdue_accounts', priority: 'high', title: 'Collect overdue fees', count: odAgg[0]?.accounts || 0, totalAmount: odAgg[0]?.amount || 0,
                suggestedAction: 'Send fee reminders', items: odList.map((p2) => ({ paymentId: p2._id, studentId: p2.studentId?._id, name: p2.studentId?.name || 'Unknown', mobile: p2.studentId?.mobile || '', seat: p2.studentId?.seatNumber || '', dueAmount: p2.dueAmount, dueDate: istDateKey(p2.dueDate) }))
            },
            {
                key: 'unassigned_paid', priority: 'medium', title: 'Active members without an assigned seat', count: unCount,
                suggestedAction: 'Assign a seat', items: unList.map((s) => ({ id: s._id, name: s.name, mobile: s.mobile }))
            },
            {
                key: 'likely_vacant_seats', priority: 'low', title: 'Seats likely to be vacant soon', count: vacant.length, availableNow: availNow, occupiedSeats: vacCount,
                suggestedAction: 'Plan renewals or re-allocate seats', items: vacant.slice(0, cap).map((s) => ({ seatId: s._id, seat: s.seatNumber, floor: s.floor, room: s.room, student: s.studentId.name, membershipExpiry: istDateKey(s.studentId.expiryDate) }))
            }
        ]
    };
};

exports.overview = async (L, p) => {
    const [health, actions, pipeline] = await Promise.all([exports.healthScore(L, p), exports.actionList(L, { ...p, listLimit: 5 }), exports.expiryPipeline(L, { ...p, listLimit: 0 })]);
    return { health, actions: actions.actions.map(({ items, ...a }) => a), expiryPipeline: pipeline.buckets.map(({ students, ...b }) => b) };
};
