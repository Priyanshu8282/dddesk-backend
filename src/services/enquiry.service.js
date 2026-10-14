const mongoose = require('mongoose');
const Enquiry = require('../models/enquiry.model');
const Library = require('../models/library.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Admin = require('../models/admin.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');

const DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const assertId = (id, label = 'ID') => { if (!isId(id)) throw new ApiError(400, `Invalid ${label}`); };

// Resolve the target library of a public submission (slug or libraryId). Must be active.
const resolvePublicLibrary = async ({ slug, libraryId }) => {
    if (!slug && !libraryId) throw new ApiError(400, 'Library slug or ID is required to submit an enquiry');
    const filter = { status: 'active', isDeleted: { $ne: true } };
    if (libraryId) {
        assertId(libraryId, 'library ID');
        filter._id = libraryId;
    } else {
        filter.slug = String(slug).toLowerCase();
    }
    const lib = await Library.findOne(filter).select('_id name slug');
    if (!lib) throw new ApiError(404, 'Library not found');
    return lib;
};

/**
 * Create an enquiry. Returns { enquiry, duplicate }.
 * A repeat submission from the same mobile within an hour is not stored twice.
 */
const createEnquiry = async (libraryId, data, { source, createdBy, ip, branchId = null } = {}) => {
    const fields = pick(data, ['name', 'mobile', 'email', 'address', 'message', 'sourceDetail', 'followUpDate']);
    if (fields.email === '') delete fields.email;

    const recent = await Enquiry.findOne({
        libraryId, mobile: fields.mobile, createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
    });
    if (recent) return { enquiry: recent, duplicate: true };

    const enquiry = await Enquiry.create({
        ...fields, libraryId, branchId: branchId || null, source: source || 'walk-in', createdBy: createdBy || undefined,
        ipAddress: ip, statusHistory: [{ status: 'new', by: createdBy || undefined }]
    });
    return { enquiry, duplicate: false };
};

const notifyOwner = (libraryId, enquiry) => {
    try {
        const { notifyEvent } = require('./notification.service');
        notifyEvent('enquiry', libraryId, {
            toAdmins: true,
            variables: {
                name: enquiry.name, mobile: enquiry.mobile,
                messageSuffix: enquiry.message ? `: "${enquiry.message.slice(0, 80)}"` : ''
            },
            data: { enquiryId: String(enquiry._id), screen: 'enquiries' }
        }).catch(() => {});
    } catch (_) { /* best effort */ }
};

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
const listEnquiries = async (libraryId, query = {}, scope = {}) => {
    const filter = { libraryId, ...scope };
    if (query.status) filter.status = query.status;
    if (query.source) filter.source = query.source;
    if (query.assignedTo) filter.assignedTo = query.assignedTo;
    if (query.search) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ name: rx }, { mobile: rx }, { email: rx }];
    }
    if (query.from || query.to) {
        filter.createdAt = {};
        if (query.from) filter.createdAt.$gte = new Date(query.from);
        if (query.to) { const t = new Date(query.to); t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
    }
    if (query.followUpDue) {
        filter.followUpDate = { $lte: new Date() };
        filter.status = filter.status || { $nin: ['converted', 'rejected', 'closed'] };
    }
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const [data, total] = await Promise.all([
        Enquiry.find(filter).populate('assignedTo', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Enquiry.countDocuments(filter)
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
};

const getEnquiry = async (id, libraryId) => {
    assertId(id);
    return Enquiry.findOne({ _id: id, libraryId }).populate('assignedTo', 'name').populate('convertedStudentId', 'name mobile');
};

const updateEnquiry = async (id, libraryId, body, userId) => {
    assertId(id);
    const set = pick(body, ['name', 'mobile', 'email', 'address', 'message', 'sourceDetail', 'status', 'followUpDate', 'notes']);
    const update = {};

    if (set.status === 'converted') {
        throw new ApiError(400, 'Use the convert endpoint to convert an enquiry into a student');
    }
    if (body.assignedTo !== undefined) {
        if (body.assignedTo) {
            const ok = await Admin.exists({ _id: body.assignedTo, libraryId, isDeleted: false });
            if (!ok) throw new ApiError(400, 'Assignee does not belong to this library');
        }
        set.assignedTo = body.assignedTo || null;
    }
    if (set.email === '') set.email = undefined;

    const existing = await Enquiry.findOne({ _id: id, libraryId });
    if (!existing) return null;
    if (existing.status === 'converted' && set.status && set.status !== 'converted') {
        throw new ApiError(400, 'A converted enquiry cannot change status');
    }

    update.$set = set;
    if (set.status && set.status !== existing.status) {
        update.$push = { statusHistory: { status: set.status, at: new Date(), by: userId } };
    }
    if (body.note) {
        update.$push = { ...(update.$push || {}), notes: body.note };
    }
    if (!Object.keys(set).length) delete update.$set;
    if (!Object.keys(update).length) return existing;

    return Enquiry.findOneAndUpdate({ _id: id, libraryId }, update, { new: true });
};

const deleteEnquiry = async (id, libraryId) => {
    assertId(id);
    return Enquiry.findOneAndUpdate({ _id: id, libraryId }, { $set: { isDeleted: true } });
};

/**
 * Convert an enquiry into a student (or link to an existing student with the same mobile
 * in this library). Plan and seat are optional; failures there come back as warnings and
 * never undo the student creation.
 */
const convertEnquiry = async (id, libraryId, body, req) => {
    assertId(id);
    const actorId = req?.user?._id;
    const enquiry = await Enquiry.findOne({ _id: id, libraryId });
    if (!enquiry) throw new ApiError(404, 'Enquiry not found');
    if (enquiry.convertedStudentId || enquiry.convertedAt) throw new ApiError(409, 'Enquiry is already converted');

    let plan = null;
    if (body.planId) {
        plan = await Plan.findOne({ _id: body.planId, libraryId });
        if (!plan) throw new ApiError(400, 'Plan does not belong to this library');
    }
    if (body.seatId) {
        const Seat = require('../models/seat.model');
        const seat = await Seat.findOne({ _id: body.seatId, libraryId });
        if (!seat) throw new ApiError(400, 'Seat does not belong to this library');
    }

    // Lock the enquiry atomically (concurrent converts lose here, before anything is created)
    const lock = await Enquiry.findOneAndUpdate(
        { _id: enquiry._id, libraryId, convertedStudentId: null, convertedAt: { $exists: false } },
        { $set: { convertedAt: new Date() } },
        { new: true }
    );
    if (!lock) throw new ApiError(409, 'Enquiry is already converted');
    const unlock = () => Enquiry.updateOne({ _id: enquiry._id, libraryId, convertedStudentId: null }, { $unset: { convertedAt: 1 } }).catch(() => {});

    const studentService = require('./student.service');
    const seatService = require('./seat.service');
    const mobile = body.mobile || enquiry.mobile;
    const warnings = [];
    let student;
    let created = false;
    let tempPassword = null;

    try {
        const existing = await Student.findOne({ libraryId, mobile });
        if (existing) {
            student = existing;
            if (plan) {
                try {
                    await studentService.assignPlan(student._id, libraryId, { planId: plan._id, joiningDate: body.joiningDate }, req);
                } catch (e) { warnings.push(`Plan not assigned: ${e.message}`); }
            }
            if (body.seatId) {
                try {
                    await seatService.assignSeat(body.seatId, student._id, libraryId, seatService.actorOf(req));
                } catch (e) { warnings.push(`Seat not assigned: ${e.message}`); }
            }
        } else {
            const reg = await studentService.registerStudent(libraryId, {
                name: body.name || enquiry.name,
                mobile,
                email: body.email || enquiry.email || undefined,
                address: enquiry.address || undefined,
                branchId: enquiry.branchId || undefined,
                joiningDate: body.joiningDate ? new Date(body.joiningDate) : undefined,
                planId: plan ? String(plan._id) : undefined,
                seatId: body.seatId
            }, req);
            student = reg.student;
            created = true;
            tempPassword = reg.credentials?.tempPassword || null;
            warnings.push(...(reg.warnings || []));
        }
    } catch (e) {
        await unlock();
        throw e;
    }

    const claimed = await Enquiry.findOneAndUpdate(
        { _id: enquiry._id, libraryId },
        {
            $set: { status: 'converted', convertedStudentId: student._id, convertedAt: new Date() },
            $push: { statusHistory: { status: 'converted', at: new Date(), by: actorId } }
        },
        { new: true }
    );

    return { enquiry: claimed, student: { _id: student._id, name: student.name, mobile: student.mobile }, created, tempPassword, warnings };
};

const conversionStats = async (libraryId, { from, to } = {}, scope = {}) => {
    const match = { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, ...scope };
    if (from || to) {
        match.createdAt = {};
        if (from) match.createdAt.$gte = new Date(from);
        if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); match.createdAt.$lte = t; }
    }
    const [byStatus, bySource, bySourceConverted] = await Promise.all([
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Enquiry.aggregate([{ $match: match }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
        Enquiry.aggregate([{ $match: { ...match, status: 'converted' } }, { $group: { _id: '$source', count: { $sum: 1 } } }])
    ]);
    const statusCounts = Object.fromEntries(Enquiry.STATUSES.map((s) => [s, 0]));
    byStatus.forEach((r) => { statusCounts[r._id] = r.count; });
    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const converted = statusCounts.converted || 0;
    const convMap = Object.fromEntries(bySourceConverted.map((r) => [r._id, r.count]));
    return {
        total, converted,
        conversionRate: total ? Math.round((converted / total) * 1000) / 10 : 0,
        byStatus: statusCounts,
        bySource: bySource.map((r) => ({
            source: r._id, count: r.count, converted: convMap[r._id] || 0,
            conversionRate: r.count ? Math.round(((convMap[r._id] || 0) / r.count) * 1000) / 10 : 0
        }))
    };
};

module.exports = {
    resolvePublicLibrary, createEnquiry, notifyOwner, listEnquiries, getEnquiry,
    updateEnquiry, deleteEnquiry, convertEnquiry, conversionStats
};

// Append a follow-up note (staff). Returns null when the enquiry is not in this library.
module.exports.addNote = async (id, libraryId, text) => {
    assertId(id);
    return Enquiry.findOneAndUpdate({ _id: id, libraryId }, { $push: { notes: text } }, { new: true });
};
