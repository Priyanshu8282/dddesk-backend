const mongoose = require('mongoose');
const crypto = require('crypto');
const Complaint = require('../models/complaint.model');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');

const isStudentUser = (user) => user.userType === 'student';
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid complaint ID');
};

// Allowed status moves (staff). Resolved/closed tickets can be re-opened.
const TRANSITIONS = {
    open: ['assigned', 'in_progress', 'resolved', 'closed'],
    assigned: ['open', 'in_progress', 'resolved', 'closed'],
    in_progress: ['assigned', 'resolved', 'closed'],
    resolved: ['closed', 'in_progress', 'open'],
    closed: ['open']
};

const STATUS_LABEL = { open: 'open', assigned: 'assigned', in_progress: 'in progress', resolved: 'resolved', closed: 'closed' };

const generateTicketId = () => {
    const d = new Date();
    return `TKT-${d.getFullYear().toString().slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const populateAll = (q) => q
    .populate('studentId', 'name mobile email seatNumber rollNumber')
    .populate('assignedTo', 'name mobile email')
    .populate('resolvedBy', 'name email');

// Shape a ticket for its viewer: students never see internal notes
const present = (complaint, user) => {
    const obj = complaint.toObject ? complaint.toObject() : complaint;
    if (isStudentUser(user)) {
        obj.notes = (obj.notes || []).filter((n) => !n.isInternal);
        delete obj.cost;
        delete obj.expenseId;
        delete obj.statusHistory;
        if (obj.assignedTo) obj.assignedTo = { name: obj.assignedTo.name };
    }
    return obj;
};

// Best-effort notifications (never block or fail the request)
const notifyStudentOfStatus = (complaint, status) => {
    if (!complaint.studentId) return;
    try {
        const { notifyEvent } = require('./notification.service');
        notifyEvent('complaint-update', complaint.libraryId, {
            studentId: complaint.studentId._id || complaint.studentId,
            variables: { subject: complaint.title, status: STATUS_LABEL[status] || status },
            data: { complaintId: String(complaint._id), ticketId: complaint.ticketId, status, screen: 'complaints' }
        }).catch(() => {});
    } catch (_) { /* best effort */ }
};

const notifyStaffAssigned = (complaint, staffId) => {
    try {
        const { notifyEvent } = require('./notification.service');
        notifyEvent('complaint-update', complaint.libraryId, {
            adminIds: [staffId],
            title: 'Complaint assigned to you',
            message: `${complaint.ticketId}: ${complaint.title}`,
            data: { complaintId: String(complaint._id), ticketId: complaint.ticketId, screen: 'complaints' }
        }).catch(() => {});
    } catch (_) { /* best effort */ }
};

const splitFiles = (files = []) => {
    const images = []; const videos = [];
    for (const f of files) {
        const p = f.path.replace(/\\/g, '/');
        if (f.mediaKind === 'video') videos.push(p);
        else if (f.mediaKind === 'image') images.push(p);
    }
    return { images, videos };
};

exports.createComplaint = async (data, user, files = [], libraryId) => {
    const isStudent = isStudentUser(user);
    const { images, videos } = splitFiles(files);
    const payload = {
        ...pick(data, ['title', 'description', 'category', 'priority', 'seatNumber', 'room']),
        libraryId, images, videos,
        createdBy: user._id,
        createdByModel: isStudent ? 'Student' : 'Admin'
    };

    if (isStudent) {
        // Students file tickets for themselves only; cannot assign or mark urgent
        if (payload.priority === 'urgent') payload.priority = 'high';
        payload.studentId = user._id;
        if (!payload.seatNumber && user.seatNumber) payload.seatNumber = user.seatNumber;
        if (user.seatId) payload.seatId = user.seatId;
        if (user.branchId) payload.branchId = user.branchId;
    } else {
        if (data.branchId) {
            const Branch = require('../models/branch.model');
            const branch = await Branch.findOne({ _id: data.branchId, libraryId, isDeleted: { $ne: true } });
            if (!branch) throw new ApiError(400, 'Branch does not belong to this library');
            payload.branchId = branch._id;
        }
        if (data.studentId) {
            const student = await Student.findOne({ _id: data.studentId, libraryId });
            if (!student) throw new ApiError(400, 'Student does not belong to this library');
            payload.studentId = student._id;
            if (!payload.seatNumber && student.seatNumber) payload.seatNumber = student.seatNumber;
            if (student.seatId) payload.seatId = student.seatId;
        }
        if (data.seatId && !payload.seatId) {
            const Seat = require('../models/seat.model');
            const seat = await Seat.findOne({ _id: data.seatId, libraryId });
            if (!seat) throw new ApiError(400, 'Seat does not belong to this library');
            payload.seatId = seat._id;
            if (!payload.seatNumber) payload.seatNumber = seat.seatNumber;
        }
        if (data.assignedTo) {
            const staff = await Admin.findOne({ _id: data.assignedTo, libraryId, isDeleted: false });
            if (!staff) throw new ApiError(400, 'Assignee does not belong to this library');
            payload.assignedTo = staff._id;
            payload.assignedAt = new Date();
            payload.status = 'assigned';
        }
    }

    let complaint;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            complaint = await Complaint.create({ ...payload, ticketId: generateTicketId() });
            break;
        } catch (e) {
            if (!(e.code === 11000 && attempt < 2)) throw e;
        }
    }
    if (complaint.assignedTo) notifyStaffAssigned(complaint, complaint.assignedTo);
    if (isStudent) {
        try {
            const { notifyEvent } = require('./notification.service');
            notifyEvent('complaint-new', libraryId, {
                toAdmins: true,
                variables: { category: complaint.category, fromName: user.name || 'a student', subject: complaint.title },
                data: { complaintId: String(complaint._id), ticketId: complaint.ticketId, screen: 'complaints' }
            }).catch(() => {});
        } catch (_) { /* best effort */ }
    }
    return present(await populateAll(Complaint.findById(complaint._id)), user);
};

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
exports.listComplaints = async (libraryId, query = {}, user, scope = {}) => {
    const filter = { libraryId };

    if (isStudentUser(user)) {
        filter.studentId = user._id; // never matches tickets without a student
    } else if (query.studentId) {
        filter.studentId = query.studentId;
    }
    for (const k of ['status', 'category', 'priority', 'assignedTo', 'branchId']) {
        if (query[k]) filter[k] = query[k];
    }
    Object.assign(filter, scope);
    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) filter.createdAt.$gte = new Date(query.startDate);
        if (query.endDate) { const end = new Date(query.endDate); end.setHours(23, 59, 59, 999); filter.createdAt.$lte = end; }
    }
    if (query.search && String(query.search).trim()) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ ticketId: rx }, { title: rx }, { description: rx }, { seatNumber: rx }];
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const [rows, total] = await Promise.all([
        populateAll(Complaint.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)),
        Complaint.countDocuments(filter)
    ]);
    return { data: rows.map((r) => present(r, user)), total, page, totalPages: Math.ceil(total / limit), limit };
};

const loadOwned = async (id, libraryId, user, populate = true) => {
    assertId(id);
    const q = Complaint.findOne({ _id: id, libraryId });
    const complaint = await (populate ? populateAll(q) : q);
    if (!complaint) throw new ApiError(404, 'Complaint ticket not found');
    if (isStudentUser(user)) {
        const owner = complaint.studentId && (complaint.studentId._id || complaint.studentId);
        if (!owner || String(owner) !== String(user._id)) {
            throw new ApiError(404, 'Complaint ticket not found');
        }
    }
    return complaint;
};

exports.getComplaintById = async (id, libraryId, user) => present(await loadOwned(id, libraryId, user), user);

exports.updateComplaint = async (id, libraryId, body, user, files = []) => {
    const complaint = await loadOwned(id, libraryId, user, false);
    if (isStudentUser(user)) {
        if (complaint.status !== 'open') throw new ApiError(400, 'Cannot edit complaint after staff has started working on it');
        const set = pick(body, ['title', 'description', 'category', 'seatNumber', 'room']);
        complaint.set(set);
    } else {
        const set = pick(body, ['title', 'description', 'category', 'priority', 'seatNumber', 'room', 'resolutionNote', 'cost']);
        complaint.set(set);
    }
    if (files.length) {
        const { images, videos } = splitFiles(files);
        if (images.length) complaint.images = [...complaint.images, ...images].slice(-10);
        if (videos.length) complaint.videos = [...complaint.videos, ...videos].slice(-5);
    }
    await complaint.save();
    return exports.getComplaintById(id, libraryId, user);
};

exports.updateStatus = async (id, libraryId, status, resolutionNote, cost, user) => {
    const complaint = await loadOwned(id, libraryId, user, false);
    const previous = complaint.status;
    if (previous === status) throw new ApiError(400, `Ticket is already ${STATUS_LABEL[status]}`);
    if (!(TRANSITIONS[previous] || []).includes(status)) {
        throw new ApiError(400, `Cannot move a ticket from ${STATUS_LABEL[previous]} to ${STATUS_LABEL[status]}`);
    }

    const now = new Date();
    const set = { status };
    if (resolutionNote) set.resolutionNote = resolutionNote;
    if (cost !== undefined && cost !== null) set.cost = Number(cost) || 0;
    if (status === 'resolved') { set.resolvedAt = now; set.resolvedBy = user._id; }
    if (status === 'closed') { set.closedAt = now; set.closedBy = user._id; }
    if (status === 'in_progress' && !complaint.assignedTo) { set.assignedTo = user._id; set.assignedAt = now; }

    // Atomic: only apply if nobody changed the status meanwhile
    const updated = await Complaint.findOneAndUpdate(
        { _id: id, libraryId, status: previous },
        {
            $set: set,
            $push: {
                statusHistory: { from: previous, to: status, by: user._id, at: now },
                notes: {
                    author: user._id, authorModel: 'Admin', authorName: user.name || 'Staff',
                    message: `Status updated from "${previous}" to "${status}"${resolutionNote ? ': ' + resolutionNote : ''}`,
                    isInternal: false, createdAt: now
                }
            }
        },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Ticket was updated by someone else. Please refresh and retry.');
    notifyStudentOfStatus(updated, status);
    return exports.getComplaintById(id, libraryId, user);
};

exports.assignStaff = async (id, libraryId, assignedTo, notes, user) => {
    assertId(id);
    const staff = await Admin.findOne({ _id: assignedTo, libraryId, isDeleted: false });
    if (!staff) throw new ApiError(404, 'Staff member not found in this library');

    const now = new Date();
    const existing = await Complaint.findOne({ _id: id, libraryId });
    if (!existing) throw new ApiError(404, 'Complaint ticket not found');
    if (existing.status === 'closed') throw new ApiError(400, 'Cannot assign a closed ticket');

    const set = { assignedTo: staff._id, assignedAt: now };
    if (notes) set.assignedNotes = notes;
    const becomesAssigned = existing.status === 'open';
    if (becomesAssigned) set.status = 'assigned';

    const updated = await Complaint.findOneAndUpdate(
        { _id: id, libraryId, status: existing.status },
        {
            $set: set,
            $push: {
                notes: {
                    author: user._id, authorModel: 'Admin', authorName: user.name || 'Admin',
                    message: `Ticket assigned to ${staff.name}${notes ? ': ' + notes : ''}`,
                    isInternal: true, createdAt: now
                },
                ...(becomesAssigned ? { statusHistory: { from: 'open', to: 'assigned', by: user._id, at: now } } : {})
            }
        },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Ticket was updated by someone else. Please refresh and retry.');
    notifyStaffAssigned(updated, staff._id);
    if (becomesAssigned) notifyStudentOfStatus(updated, 'assigned');
    return exports.getComplaintById(id, libraryId, user);
};

exports.addNote = async (id, libraryId, body, user) => {
    const complaint = await loadOwned(id, libraryId, user, false);
    const student = isStudentUser(user);
    if (student && complaint.status === 'closed') throw new ApiError(400, 'This ticket is closed');
    complaint.notes.push({
        author: user._id,
        authorModel: student ? 'Student' : 'Admin',
        authorName: user.name || (student ? 'Student' : 'Staff'),
        message: body.message,
        isInternal: student ? false : !!body.isInternal,
        createdAt: new Date()
    });
    await complaint.save();
    return exports.getComplaintById(id, libraryId, user);
};

exports.deleteComplaint = async (id, libraryId) => {
    assertId(id);
    const res = await Complaint.findOneAndUpdate({ _id: id, libraryId }, { $set: { isDeleted: true } });
    if (!res) throw new ApiError(404, 'Complaint ticket not found');
    return true;
};

exports.getStats = async (libraryId, scope = {}) => {
    const match = { libraryId: oid(libraryId), isDeleted: false, ...scope };
    const [counts, categoryAgg, urgentCount] = await Promise.all([
        Complaint.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Complaint.aggregate([{ $match: match }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
        Complaint.countDocuments({ libraryId, ...scope, priority: 'urgent', status: { $in: ['open', 'assigned', 'in_progress'] } })
    ]);

    const statusMap = { open: 0, assigned: 0, in_progress: 0, resolved: 0, closed: 0 };
    let total = 0;
    counts.forEach((c) => { if (statusMap[c._id] !== undefined) statusMap[c._id] = c.count; total += c.count; });

    return {
        total,
        active: statusMap.open + statusMap.assigned + statusMap.in_progress,
        open: statusMap.open,
        assigned: statusMap.assigned,
        inProgress: statusMap.in_progress,
        resolved: statusMap.resolved,
        closed: statusMap.closed,
        urgentActive: urgentCount,
        categoryBreakdown: categoryAgg.map((i) => ({ category: i._id, count: i.count }))
    };
};

// Resolved/closed tickets (what was fixed, by whom, at what cost) for a seat / room / category
exports.getMaintenanceHistory = async (libraryId, query = {}, scope = {}) => {
    const filter = { libraryId, ...scope, status: { $in: ['resolved', 'closed'] } };
    if (query.seatId) filter.seatId = query.seatId;
    if (query.seatNumber) filter.seatNumber = String(query.seatNumber);
    if (query.room) filter.room = String(query.room);
    if (query.category) filter.category = query.category;
    if (query.startDate || query.endDate) {
        filter.resolvedAt = {};
        if (query.startDate) filter.resolvedAt.$gte = new Date(query.startDate);
        if (query.endDate) { const e = new Date(query.endDate); e.setHours(23, 59, 59, 999); filter.resolvedAt.$lte = e; }
    }
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const [rows, total, [cost]] = await Promise.all([
        Complaint.find(filter)
            .select('ticketId title category priority seatNumber room seatId status resolutionNote cost createdAt resolvedAt closedAt')
            .populate('resolvedBy', 'name').populate('assignedTo', 'name')
            .sort({ resolvedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Complaint.countDocuments(filter),
        Complaint.aggregate([
            { $match: { ...filter, libraryId: oid(libraryId), isDeleted: false, ...(filter.seatId ? { seatId: oid(filter.seatId) } : {}) } },
            { $group: { _id: null, totalCost: { $sum: '$cost' } } }
        ])
    ]);
    return { data: rows, total, page, totalPages: Math.ceil(total / limit), limit, totalCost: cost ? cost.totalCost : 0 };
};

// Same fault on the same seat/room at least `min` times in the last `days` days
exports.getRecurringIssues = async (libraryId, { days = 30, min = 3 } = {}, scope = {}) => {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const groups = await Complaint.aggregate([
        { $match: { libraryId: oid(libraryId), isDeleted: false, ...scope, createdAt: { $gte: since } } },
        { $addFields: { location: { $ifNull: [{ $cond: [{ $ne: ['$seatNumber', null] }, '$seatNumber', null] }, '$room'] } } },
        { $match: { location: { $nin: [null, ''] } } },
        { $group: {
            _id: { category: '$category', location: '$location' },
            count: { $sum: 1 },
            lastReportedAt: { $max: '$createdAt' },
            totalCost: { $sum: '$cost' },
            tickets: { $push: { _id: '$_id', ticketId: '$ticketId', title: '$title', status: '$status', createdAt: '$createdAt' } }
        } },
        { $match: { count: { $gte: min } } },
        { $sort: { count: -1, lastReportedAt: -1 } },
        { $limit: 100 }
    ]);
    return groups.map((g) => ({
        category: g._id.category, location: g._id.location, count: g.count,
        lastReportedAt: g.lastReportedAt, totalCost: g.totalCost, windowDays: days, tickets: g.tickets
    }));
};
