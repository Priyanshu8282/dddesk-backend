// Tabular report datasets. Each dataset describes a tenant-scoped query once and is reused for
// paginated JSON (runDataset) and full-dataset streaming exports (iterateDataset).
const Payment = require('../models/payment.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Attendance = require('../models/attendance.model');
const Expense = require('../models/expense.model');
const Complaint = require('../models/complaint.model');
const Enquiry = require('../models/enquiry.model');
const SeatHistory = require('../models/seatHistory.model');
const ApiError = require('../utils/ApiError');
const { startOfDayIST, endOfDayIST, addDaysIST, istDateKey, toISTString } = require('../utils/time');
const { oid, hasPath, branchCond, rangeFilter, searchRegex, pagination, round1, istDayExpr, IST } = require('./reportQuery');

const MAX_DIRECT_SEARCH_IDS = 2000;

// ---------- shared filter pieces ----------
const studentIdsBySearch = async (L, search) => {
    const rx = searchRegex(search);
    const rows = await Student.find({ libraryId: L, $or: [{ name: rx }, { mobile: rx }, { rollNumber: rx }, { seatNumber: rx }] })
        .select('_id').limit(MAX_DIRECT_SEARCH_IDS).lean();
    return rows.map((r) => r._id);
};

// floor / room / branch are properties of seats; students are matched through their seat
const seatIdsForLocation = async (L, q) => {
    if (!q.floor && !q.room) return null;
    const f = { libraryId: L };
    if (q.floor) f.floor = q.floor;
    if (q.room) f.room = q.room;
    const rows = await Seat.find(f).select('_id').limit(20000).lean();
    return rows.map((r) => r._id);
};

const studentBase = async (L, q, forced = {}) => {
    const f = { libraryId: L, isDeleted: { $ne: true }, ...forced };
    if (q.status && !forced.status) f.status = q.status;
    if (q.planId) f.planId = oid(q.planId);
    Object.assign(f, branchCond(q));
    const seatIds = await seatIdsForLocation(L, q);
    if (seatIds) f.seatId = { $in: seatIds };
    if (q.search) {
        const rx = searchRegex(q.search);
        f.$or = [{ name: rx }, { mobile: rx }, { rollNumber: rx }, { seatNumber: rx }];
    }
    return f;
};

// A payment belongs to the period of its payment date (or creation date when none recorded)
const payDateCond = (p) => {
    const r = rangeFilter(p);
    if (!r) return null;
    return { $or: [{ paymentDate: r }, { paymentDate: null, createdAt: r }] };
};

const paymentBase = async (L, q, extra = {}) => {
    const and = [];
    const f = { libraryId: L, paymentStatus: { $ne: 'cancelled' }, ...extra };
    if (q.status) f.paymentStatus = q.status;
    if (q.method) f.paymentMethod = q.method;
    if (q.planId) f.planId = oid(q.planId);
    if (q.paymentType) f.paymentType = q.paymentType;
    Object.assign(f, branchCond(q));
    const dc = payDateCond(q);
    if (dc) and.push(dc);
    if (q.search) {
        const ids = await studentIdsBySearch(L, q.search);
        and.push({ $or: [{ studentId: { $in: ids } }, { receiptNumber: searchRegex(q.search) }] });
    }
    const seatIds = await seatIdsForLocation(L, q);
    if (seatIds) {
        const stu = await Student.find({ libraryId: L, seatId: { $in: seatIds } }).select('_id').limit(20000).lean();
        and.push({ studentId: { $in: stu.map((s) => s._id) } });
    }
    if (and.length) f.$and = and;
    return f;
};

const d = (v) => (v ? istDateKey(v) : '');
const dt = (v) => (v ? toISTString(v) : '');
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const daysLeft = (expiry) => (expiry ? Math.ceil((startOfDayIST(expiry).getTime() - startOfDayIST(new Date()).getTime()) / 86400000) : '');

// ---------- columns ----------
const STUDENT_COLS = [
    { key: 'rollNumber', label: 'Roll Number' }, { key: 'name', label: 'Student Name' }, { key: 'mobile', label: 'Mobile' },
    { key: 'email', label: 'Email' }, { key: 'seatNumber', label: 'Seat' }, { key: 'planName', label: 'Plan' },
    { key: 'status', label: 'Status' }, { key: 'planStatus', label: 'Membership' }, { key: 'joiningDate', label: 'Joining Date' },
    { key: 'expiryDate', label: 'Expiry Date' }, { key: 'daysToExpiry', label: 'Days To Expiry' }
];
const studentRow = (s) => ({
    rollNumber: s.rollNumber || '', name: s.name, mobile: s.mobile, email: s.email || '', seatNumber: s.seatNumber || 'Unassigned',
    planName: s.planId?.name || '', status: s.status, planStatus: s.planStatus || '', joiningDate: d(s.joiningDate),
    expiryDate: d(s.expiryDate), daysToExpiry: daysLeft(s.expiryDate)
});

const PAYMENT_COLS = [
    { key: 'date', label: 'Payment Date' }, { key: 'studentName', label: 'Student Name' }, { key: 'mobile', label: 'Mobile' },
    { key: 'rollNumber', label: 'Roll Number' }, { key: 'planName', label: 'Plan' }, { key: 'paymentType', label: 'Type' },
    { key: 'totalAmount', label: 'Total (INR)' }, { key: 'discountAmount', label: 'Discount (INR)' }, { key: 'paidAmount', label: 'Paid (INR)' },
    { key: 'dueAmount', label: 'Due (INR)' }, { key: 'refundAmount', label: 'Refund (INR)' }, { key: 'paymentMethod', label: 'Method' },
    { key: 'paymentStatus', label: 'Status' }, { key: 'dueDate', label: 'Due Date' }, { key: 'receiptNumber', label: 'Receipt No' }
];
const paymentRow = (p) => ({
    date: d(p.paymentDate || p.createdAt), studentName: p.studentId?.name || 'Unknown', mobile: p.studentId?.mobile || '',
    rollNumber: p.studentId?.rollNumber || '', planName: p.planId?.name || '', paymentType: p.paymentType || '',
    totalAmount: num(p.totalAmount), discountAmount: num(p.discountAmount), paidAmount: num(p.paidAmount), dueAmount: num(p.dueAmount),
    refundAmount: num(p.refundAmount), paymentMethod: p.paymentMethod || '', paymentStatus: p.paymentStatus || '',
    dueDate: d(p.dueDate), receiptNumber: p.receiptNumber || ''
});
const PAY_TOTALS = {
    billed: { $sum: '$totalAmount' }, discount: { $sum: '$discountAmount' }, paid: { $sum: '$paidAmount' },
    due: { $sum: '$dueAmount' }, refunded: { $sum: '$refundAmount' }
};
const payFind = (cols, filterFn, sort = { paymentDate: -1, createdAt: -1 }) => ({
    columns: cols,
    build: async (L, q) => ({
        kind: 'find', model: Payment, filter: await filterFn(L, q), sort,
        populate: [{ path: 'studentId', select: 'name mobile rollNumber' }, { path: 'planId', select: 'name' }],
        row: paymentRow, totalsGroup: PAY_TOTALS
    })
});

const ENQ_COLS = [
    { key: 'date', label: 'Enquiry Date' }, { key: 'name', label: 'Name' }, { key: 'mobile', label: 'Mobile' }, { key: 'email', label: 'Email' },
    { key: 'source', label: 'Source' }, { key: 'status', label: 'Status' }, { key: 'followUpDate', label: 'Follow-up Date' },
    { key: 'message', label: 'Message' }, { key: 'convertedAt', label: 'Converted On' }
];
const enqRow = (e) => ({
    date: dt(e.createdAt), name: e.name, mobile: e.mobile, email: e.email || '', source: e.source, status: e.status,
    followUpDate: d(e.followUpDate), message: e.message || '', convertedAt: d(e.convertedAt)
});
const enqBase = (L, q, extra = {}) => {
    const f = { libraryId: L, isDeleted: { $ne: true }, ...branchCond(q), ...extra };
    if (q.status && !extra.status) f.status = q.status;
    if (q.source && !extra.source) f.source = q.source;
    const r = rangeFilter(q);
    if (r && !extra.followUpDate) f.createdAt = r;
    if (q.search) { const rx = searchRegex(q.search); f.$or = [{ name: rx }, { mobile: rx }, { email: rx }]; }
    return f;
};
const enqDataset = (filterFn) => ({
    columns: ENQ_COLS,
    build: async (L, q) => ({ kind: 'find', model: Enquiry, filter: filterFn(L, q), sort: { createdAt: -1 }, row: enqRow, totalsGroup: {} })
});

const ATT_BASE = async (L, q, presentOnly = false) => {
    const f = { libraryId: L, ...branchCond(q) };
    const r = rangeFilter(q);
    if (r) f.checkIn = r;
    if (q.status) f.status = q.status;
    else if (presentOnly) f.status = 'present';
    if (q.search) f.studentId = { $in: await studentIdsBySearch(L, q.search) };
    const seatIds = await seatIdsForLocation(L, q);
    if (seatIds) {
        const stu = await Student.find({ libraryId: L, seatId: { $in: seatIds } }).select('_id').limit(20000).lean();
        f.studentId = f.studentId ? { $in: (f.studentId.$in || []).filter((id) => stu.some((s) => String(s._id) === String(id))) } : { $in: stu.map((s) => s._id) };
    }
    return f;
};

// IST bucket for a check-in time
const SHIFT_EXPR = {
    $switch: {
        branches: [
            { case: { $and: [{ $gte: [{ $hour: { date: '$checkIn', timezone: IST } }, 5] }, { $lt: [{ $hour: { date: '$checkIn', timezone: IST } }, 12] }] }, then: 'Morning (5-12)' },
            { case: { $and: [{ $gte: [{ $hour: { date: '$checkIn', timezone: IST } }, 12] }, { $lt: [{ $hour: { date: '$checkIn', timezone: IST } }, 17] }] }, then: 'Afternoon (12-17)' },
            { case: { $and: [{ $gte: [{ $hour: { date: '$checkIn', timezone: IST } }, 17] }, { $lt: [{ $hour: { date: '$checkIn', timezone: IST } }, 21] }] }, then: 'Evening (17-21)' }
        ],
        default: 'Night (21-5)'
    }
};

const attAggregate = (groupKeyExpr, keyField, keyLabel) => ({
    columns: [
        { key: keyField, label: keyLabel }, { key: 'present', label: 'Students Present' }, { key: 'checkIns', label: 'Check-ins' },
        { key: 'avgMinutes', label: 'Avg Duration (min)' }, { key: 'attendancePct', label: 'Attendance %' }
    ],
    build: async (L, q) => {
        const active = await Student.countDocuments({ libraryId: L, status: 'active', isDeleted: { $ne: true }, ...branchCond(q) });
        return {
            kind: 'aggregate', model: Attendance,
            pipeline: [
                { $match: await ATT_BASE(L, q, true) },
                { $group: { _id: { k: groupKeyExpr, s: '$studentId' }, checkIns: { $sum: 1 }, minutes: { $sum: '$duration' } } },
                { $group: { _id: '$_id.k', present: { $sum: 1 }, checkIns: { $sum: '$checkIns' }, minutes: { $sum: '$minutes' } } },
                { $sort: { _id: 1 } },
                { $project: {
                    _id: 0, [keyField]: '$_id', present: 1, checkIns: 1,
                    avgMinutes: { $round: [{ $divide: ['$minutes', { $max: ['$checkIns', 1] }] }, 0] },
                    attendancePct: active > 0 ? { $round: [{ $multiply: [{ $divide: ['$present', active] }, 100] }, 1] } : { $literal: 0 }
                } }
            ],
            row: (r) => r
        };
    }
});

// ---------- registry ----------
const REG = {};

REG.students = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student, filter: await studentBase(L, q, rangeFilter(q) && q.start > new Date(0) ? { joiningDate: rangeFilter(q) } : {}),
    sort: { createdAt: -1 }, populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };
REG.students_active = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student, filter: await studentBase(L, q, { status: 'active' }), sort: { name: 1 },
    populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };
REG.students_inactive = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student, filter: await studentBase(L, q, { status: { $in: ['inactive', 'suspended'] } }), sort: { name: 1 },
    populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };
REG.students_joining = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student, filter: await studentBase(L, q, q.start ? { joiningDate: rangeFilter(q) } : {}), sort: { joiningDate: -1 },
    populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };
REG.students_expiry = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student,
    filter: await studentBase(L, q, { status: 'active', expiryDate: { $gte: startOfDayIST(new Date()), $lte: endOfDayIST(addDaysIST(new Date(), q.days)) } }),
    sort: { expiryDate: 1 }, populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };
REG.membership_expired = { columns: STUDENT_COLS, build: async (L, q) => ({
    kind: 'find', model: Student, filter: await studentBase(L, q, { expiryDate: { $lt: startOfDayIST(new Date()) } }), sort: { expiryDate: -1 },
    populate: [{ path: 'planId', select: 'name' }], row: studentRow, totalsGroup: {}
}) };

REG.payments = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { paidAmount: { $gt: 0 } }));
REG.payments_all = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q));
REG.dues = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { dueAmount: { $gt: 0 }, paymentStatus: { $nin: ['cancelled', 'waived', 'refunded'] } }), { dueAmount: -1 });
REG.overdue = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { dueAmount: { $gt: 0 }, paymentStatus: { $nin: ['cancelled', 'waived', 'refunded'] }, dueDate: { $lt: new Date() } }), { dueDate: 1 });
REG.refunds = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { refundAmount: { $gt: 0 } }), { refundDate: -1 });
REG.credit = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { paymentStatus: 'credit' }), { dueDate: 1 });
REG.partial = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { paymentStatus: 'partial' }), { dueAmount: -1 });
REG.renewals = payFind(PAYMENT_COLS, (L, q) => paymentBase(L, q, { paymentType: 'renewal', paidAmount: { $gt: 0 } }));

REG.seats = { columns: [
    { key: 'seatNumber', label: 'Seat' }, { key: 'floor', label: 'Floor' }, { key: 'room', label: 'Room' }, { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' }, { key: 'price', label: 'Price (INR)' }, { key: 'student', label: 'Student' }, { key: 'mobile', label: 'Mobile' },
    { key: 'assignedAt', label: 'Assigned On' }, { key: 'expiryDate', label: 'Membership Expiry' }
], build: async (L, q) => {
    const f = { libraryId: L, isDeleted: { $ne: true } };
    if (q.status) f.status = q.status;
    if (q.floor) f.floor = q.floor;
    if (q.room) f.room = q.room;
    if (q.type) f.type = q.type;
    Object.assign(f, branchCond(q));
    if (q.search) f.$or = [{ seatNumber: searchRegex(q.search) }, { studentId: { $in: await studentIdsBySearch(L, q.search) } }];
    return {
        kind: 'find', model: Seat, filter: f, sort: { floor: 1, room: 1, seatNumber: 1 },
        populate: [{ path: 'studentId', select: 'name mobile expiryDate' }], totalsGroup: { revenuePotential: { $sum: '$price' } },
        row: (s) => ({
            seatNumber: s.seatNumber, floor: s.floor || '', room: s.room || '', type: s.type === 'custom' ? (s.customType || 'custom') : s.type, status: s.status,
            price: num(s.price), student: s.studentId?.name || '', mobile: s.studentId?.mobile || '', assignedAt: d(s.assignedAt), expiryDate: d(s.studentId?.expiryDate)
        })
    };
} };

REG.seat_history = { columns: [
    { key: 'at', label: 'Date/Time (IST)' }, { key: 'seatNumber', label: 'Seat' }, { key: 'action', label: 'Action' }, { key: 'student', label: 'Student' },
    { key: 'mobile', label: 'Mobile' }, { key: 'reason', label: 'Reason' }, { key: 'performedByType', label: 'By' }
], build: async (L, q) => {
    const f = { libraryId: L, ...branchCond(q) };
    const r = rangeFilter(q);
    if (r) f.at = r;
    if (q.status) f.action = q.status;
    if (q.search) f.$or = [{ seatNumber: searchRegex(q.search) }, { studentId: { $in: await studentIdsBySearch(L, q.search) } }];
    return { kind: 'find', model: SeatHistory, filter: f, sort: { at: -1 }, populate: [{ path: 'studentId', select: 'name mobile' }], totalsGroup: {},
        row: (h) => ({ at: dt(h.at), seatNumber: h.seatNumber || '', action: h.action, student: h.studentId?.name || '', mobile: h.studentId?.mobile || '', reason: h.reason || '', performedByType: h.performedByType || '' }) };
} };

REG.attendance = { columns: [
    { key: 'date', label: 'Date' }, { key: 'studentName', label: 'Student Name' }, { key: 'rollNumber', label: 'Roll Number' }, { key: 'seatNumber', label: 'Seat' },
    { key: 'checkIn', label: 'Check In (IST)' }, { key: 'checkOut', label: 'Check Out (IST)' }, { key: 'durationMinutes', label: 'Duration (min)' }, { key: 'status', label: 'Status' }
], build: async (L, q) => ({
    kind: 'find', model: Attendance, filter: await ATT_BASE(L, q), sort: { checkIn: -1 },
    populate: [{ path: 'studentId', select: 'name rollNumber seatNumber' }], totalsGroup: { minutes: { $sum: '$duration' } },
    row: (a) => ({
        date: d(a.checkIn), studentName: a.studentId?.name || 'Unknown', rollNumber: a.studentId?.rollNumber || '', seatNumber: a.studentId?.seatNumber || '',
        checkIn: dt(a.checkIn), checkOut: dt(a.checkOut), durationMinutes: num(a.duration), status: a.status
    })
}) };
REG.attendance_daily = attAggregate(istDayExpr('$checkIn'), 'date', 'Date');
REG.attendance_monthly = attAggregate(istDayExpr('$checkIn', '%Y-%m'), 'month', 'Month');
REG.attendance_shift = attAggregate(SHIFT_EXPR, 'shift', 'Shift');

REG.attendance_student = { columns: [
    { key: 'rollNumber', label: 'Roll Number' }, { key: 'name', label: 'Student Name' }, { key: 'seatNumber', label: 'Seat' },
    { key: 'daysPresent', label: 'Days Present' }, { key: 'totalHours', label: 'Total Hours' }, { key: 'attendancePct', label: 'Attendance %' }
], build: async (L, q) => {
    const days = q.start && q.end ? Math.max(1, Math.ceil((Math.min(q.end, new Date()) - q.start) / 86400000)) : 1;
    return {
        kind: 'aggregate', model: Attendance,
        pipeline: [
            { $match: await ATT_BASE(L, q, true) },
            { $group: { _id: { s: '$studentId', day: istDayExpr('$checkIn') }, minutes: { $sum: '$duration' } } },
            { $group: { _id: '$_id.s', daysPresent: { $sum: 1 }, minutes: { $sum: '$minutes' } } },
            { $lookup: { from: Student.collection.name, localField: '_id', foreignField: '_id', as: 's' } },
            { $unwind: { path: '$s', preserveNullAndEmptyArrays: true } },
            { $match: { 's.libraryId': L } },
            { $sort: { daysPresent: -1, 's.name': 1 } },
            { $project: {
                _id: 0, rollNumber: { $ifNull: ['$s.rollNumber', ''] }, name: { $ifNull: ['$s.name', 'Unknown'] }, seatNumber: { $ifNull: ['$s.seatNumber', ''] },
                daysPresent: 1, totalHours: { $round: [{ $divide: ['$minutes', 60] }, 1] },
                attendancePct: { $min: [100, { $round: [{ $multiply: [{ $divide: ['$daysPresent', days] }, 100] }, 1] }] }
            } }
        ],
        row: (r) => r
    };
} };

REG.expenses = { columns: [
    { key: 'date', label: 'Date' }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount (INR)' },
    { key: 'paymentMethod', label: 'Method' }, { key: 'notes', label: 'Notes' }
], build: async (L, q) => {
    const f = { libraryId: L, isDeleted: { $ne: true }, ...branchCond(q) };
    const r = rangeFilter(q);
    if (r) f.date = r;
    if (q.category) f.category = q.category;
    if (q.method) f.paymentMethod = q.method;
    if (q.search) f.$or = [{ title: searchRegex(q.search) }, { notes: searchRegex(q.search) }];
    return { kind: 'find', model: Expense, filter: f, sort: { date: -1 }, totalsGroup: { amount: { $sum: '$amount' } },
        row: (e) => ({ date: d(e.date), title: e.title, category: e.customCategory || e.category, amount: num(e.amount), paymentMethod: e.paymentMethod, notes: e.notes || '' }) };
} };

REG.complaints = { columns: [
    { key: 'ticketId', label: 'Ticket' }, { key: 'date', label: 'Raised On' }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' },
    { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'studentName', label: 'Student' }, { key: 'assignedTo', label: 'Assigned To' },
    { key: 'resolvedAt', label: 'Resolved On' }, { key: 'turnaroundHours', label: 'Turnaround (hrs)' }
], build: async (L, q) => {
    const f = { libraryId: L, isDeleted: { $ne: true } };
    if (q.status) f.status = q.status;
    if (q.category) f.category = q.category;
    if (q.priority) f.priority = q.priority;
    Object.assign(f, branchCond(q));
    const r = rangeFilter(q);
    if (r) f.createdAt = r;
    if (q.search) f.$or = [{ title: searchRegex(q.search) }, { ticketId: searchRegex(q.search) }];
    return { kind: 'find', model: Complaint, filter: f, sort: { createdAt: -1 }, totalsGroup: { cost: { $sum: '$cost' } },
        populate: [{ path: 'studentId', select: 'name' }, { path: 'assignedTo', select: 'name' }],
        row: (c) => ({
            ticketId: c.ticketId, date: dt(c.createdAt), title: c.title, category: c.category, priority: c.priority, status: c.status,
            studentName: c.studentId?.name || 'Facility', assignedTo: c.assignedTo?.name || 'Unassigned', resolvedAt: dt(c.resolvedAt),
            turnaroundHours: c.resolvedAt ? round1((c.resolvedAt - c.createdAt) / 3600000) : ''
        }) };
} };

REG.enquiries = enqDataset((L, q) => enqBase(L, q));
REG.enquiry_followups = enqDataset((L, q) => enqBase(L, q, {
    followUpDate: { $lte: endOfDayIST(new Date()) }, status: { $nin: ['converted', 'rejected', 'closed'] }
}));
REG.website_enquiries = enqDataset((L, q) => enqBase(L, q, { source: 'website' }));

// aliases used by the export endpoint / report views
const ALIASES = {
    collection: 'payments', payments: 'payments', membership_new: 'students_joining', membership_expiring: 'students_expiry',
    membership_renewals: 'renewals', seat_occupancy: 'seats', enquiry: 'enquiries'
};

const resolveName = (name) => {
    const key = ALIASES[name] || name;
    if (!REG[key]) throw new ApiError(400, `Unknown report type "${name}"`);
    return key;
};

const listTypes = () => Object.keys(REG).concat(Object.keys(ALIASES).filter((a) => !REG[a]));

const totalsOf = async (def) => {
    if (def.kind !== 'find') return null;
    const g = { _id: null, count: { $sum: 1 }, ...(def.totalsGroup || {}) };
    const out = await def.model.aggregate([{ $match: def.filter }, { $group: g }]);
    const { _id, ...rest } = out[0] || { count: 0 };
    return rest;
};

/** Paginated run: { columns, rows, pagination, totals } */
const runDataset = async (name, L, q) => {
    const key = resolveName(name);
    const ds = REG[key];
    const def = await ds.build(L, q);
    const skip = (q.page - 1) * q.limit;
    if (def.kind === 'find') {
        let query = def.model.find(def.filter).sort({ ...def.sort, _id: 1 }).skip(skip).limit(q.limit);
        (def.populate || []).forEach((p) => { query = query.populate(p); });
        const [docs, total, totals] = await Promise.all([query.lean(), def.model.countDocuments(def.filter), totalsOf(def)]);
        return { type: key, columns: ds.columns, rows: docs.map(def.row), pagination: pagination(q, total), totals };
    }
    const out = await def.model.aggregate([
        ...def.pipeline,
        { $facet: { rows: [{ $skip: skip }, { $limit: q.limit }], total: [{ $count: 'n' }] } }
    ]).allowDiskUse(true);
    const total = out[0]?.total[0]?.n || 0;
    return { type: key, columns: ds.columns, rows: (out[0]?.rows || []).map(def.row), pagination: pagination(q, total), totals: { count: total } };
};

/** Async iterator over the FULL filtered dataset (cursor based, no page limit). */
const iterateDataset = async function* (name, L, q) {
    const key = resolveName(name);
    const def = await REG[key].build(L, q);
    let cursor;
    if (def.kind === 'find') {
        let query = def.model.find(def.filter).sort({ ...def.sort, _id: 1 });
        (def.populate || []).forEach((p) => { query = query.populate(p); });
        cursor = query.lean().cursor({ batchSize: 500 });
    } else {
        cursor = def.model.aggregate(def.pipeline).allowDiskUse(true).cursor({ batchSize: 500 });
    }
    try {
        for await (const doc of cursor) yield def.row(doc);
    } finally {
        if (cursor.close) await cursor.close().catch(() => {});
    }
};

const getColumns = (name) => REG[resolveName(name)].columns;

module.exports = { runDataset, iterateDataset, getColumns, listTypes, resolveName, studentIdsBySearch, paymentBase, payDateCond, seatIdsForLocation };
