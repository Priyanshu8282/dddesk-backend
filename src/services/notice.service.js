const mongoose = require('mongoose');
const Notice = require('../models/notice.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Branch = require('../models/branch.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');
const { branchVisibility } = require('../utils/branchScope');
const { startOfDayIST, endOfDayIST } = require('../utils/time');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NOTICE_SORTS = {
    pinned: { isPinned: -1, createdAt: -1, _id: -1 },
    newest: { createdAt: -1, _id: -1 },
    oldest: { createdAt: 1, _id: 1 },
    title: { title: 1, _id: 1 },
    views: { views: -1, createdAt: -1 },
    start: { startDate: -1, _id: -1 },
    ending: { endDate: 1, _id: 1 }
};

const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid notice ID');
};

const normAudience = (a) => (a === 'specific' ? 'selected' : a || 'all');

// Notice is live: published, started, not ended
const timeFilter = (now = new Date()) => ({
    isActive: true,
    $and: [
        { $or: [{ startDate: { $lte: now } }, { startDate: { $exists: false } }, { startDate: null }] },
        { $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gt: now } }] }
    ]
});

const liveFilter = (libraryId, now = new Date()) => ({ libraryId, ...timeFilter(now) });

const statusOf = (n, now = new Date()) => {
    if (!n.isActive) return 'inactive';
    if (n.startDate && new Date(n.startDate) > now) return 'scheduled';
    if (n.endDate && new Date(n.endDate) <= now) return 'expired';
    return 'active';
};

// Validates that every targeted id belongs to the library; throws 400 otherwise
const validateTargets = async (libraryId, state) => {
    const audience = normAudience(state.sendTo);
    const check = async (Model, ids, label, extra = {}) => {
        const unique = [...new Set((ids || []).map(String))];
        if (!unique.length) throw new ApiError(400, `Select at least one ${label}`);
        const found = await Model.countDocuments({ _id: { $in: unique }, libraryId, ...extra });
        if (found !== unique.length) throw new ApiError(400, `One or more selected ${label}s do not belong to this library`);
    };
    if (audience === 'selected') await check(Student, state.targetStudents, 'student', { isDeleted: false });
    if (audience === 'branch') await check(Branch, state.targetBranchIds, 'branch', { isDeleted: false });
    if (audience === 'membershipGroup') await check(Plan, state.targetPlanIds, 'plan');
};

const checkDates = (startDate, endDate) => {
    if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
        throw new ApiError(400, 'End date must be after the start date');
    }
};

// Active students that should receive this notice
const resolveAudienceStudentIds = async (notice) => {
    const filter = { libraryId: notice.libraryId, status: 'active', isDeleted: false };
    // A notice that belongs to one branch only goes to that branch's students
    if (notice.branchId) filter.branchId = notice.branchId;
    switch (normAudience(notice.sendTo)) {
        case 'selected': filter._id = { $in: notice.targetStudents || [] }; break;
        case 'branch': {
            const ids = (notice.targetBranchIds || []).filter((b) => !notice.branchId || String(b) === String(notice.branchId));
            filter.branchId = { $in: ids };
            break;
        }
        case 'membershipGroup': Object.assign(filter, { planId: { $in: notice.targetPlanIds || [] }, planStatus: 'active' }); break;
        default: break;
    }
    if (notice.sendTo === 'premium') filter.planStatus = 'active'; // legacy
    const rows = await Student.find(filter).select('_id').lean();
    return rows.map((s) => s._id);
};

const TYPE_PREFIX = {
    holiday: 'Holiday', 'timing-change': 'Timing change', 'fee-reminder': 'Fee reminder', exam: 'Exam',
    maintenance: 'Maintenance', emergency: 'Emergency', important: 'Important'
};

// Delivery through the notification service (in-app + push). Emergencies also try SMS/WhatsApp.
const deliver = async (notice) => {
    try {
        const { notifyEvent } = require('./notification.service');
        const studentIds = await resolveAudienceStudentIds(notice);
        if (!studentIds.length) return;
        const prefix = TYPE_PREFIX[notice.type];
        const channels = notice.type === 'emergency' ? ['inapp', 'push', 'sms', 'whatsapp'] : ['inapp', 'push'];
        await notifyEvent('notice', notice.libraryId, {
            studentIds, channels,
            variables: { title: prefix ? `${prefix}: ${notice.title}` : notice.title, message: (notice.description || notice.title).slice(0, 180) },
            data: { noticeId: String(notice._id), noticeType: notice.type, screen: 'notices' }
        });
    } catch (e) {
        console.error('Notice delivery failed:', e.message);
    }
};

// Claim + deliver once. Returns true if this call delivered.
const deliverOnce = async (noticeId) => {
    const now = new Date();
    const notice = await Notice.findOneAndUpdate(
        { _id: noticeId, notifiedAt: null, ...timeFilter(now) },
        { $set: { notifiedAt: now } },
        { new: true }
    );
    if (notice) await deliver(notice);
    return !!notice;
};

// Cron hook: deliver scheduled notices that have just gone live.
const publishDueNotices = async () => {
    const now = new Date();
    const due = await Notice.find({
        notifiedAt: null, isActive: true, startDate: { $lte: now },
        $or: [{ endDate: null }, { endDate: { $gt: now } }]
    }).select('_id').limit(200).lean();
    let n = 0;
    for (const d of due) if (await deliverOnce(d._id)) n += 1;
    return n;
};

// ─── Staff operations ────────────────────────────────────────────────────────
const createNotice = async (libraryId, body, file, creatorId) => {
    const data = pick(body, ['title', 'description', 'type', 'isPinned', 'showOnWebsite', 'targetStudents', 'targetBranchIds', 'targetPlanIds', 'branchId']); // branchId validated by the controller
    data.sendTo = normAudience(body.sendTo);
    data.startDate = body.startDate ? new Date(body.startDate) : new Date();
    const end = body.endDate || body.expiryDate;
    data.endDate = end ? new Date(end) : null;
    data.publishDate = data.startDate;
    checkDates(data.startDate, data.endDate);
    if (data.endDate && data.endDate <= new Date()) throw new ApiError(400, 'End date must be in the future');
    await validateTargets(libraryId, data);
    // Targets of other audiences are dropped
    if (data.sendTo !== 'selected') data.targetStudents = [];
    if (data.sendTo !== 'branch') data.targetBranchIds = [];
    if (data.sendTo !== 'membershipGroup') data.targetPlanIds = [];

    if (file) {
        if (file.mediaKind !== 'image') throw new ApiError(400, 'Notice attachment must be an image');
        data.imageUrl = file.path;
    }
    data.isActive = body.isActive !== false;
    if (data.isActive) data.publishedAt = new Date();
    return Notice.create({ ...data, libraryId, createdBy: creatorId });
};

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req): notices of those branches + all-branch notices
const queryNotices = async (libraryId, { search, status = 'all', type, sendTo, pinned, from, to, sort = 'pinned', page = 1, limit = 10 } = {}, scope = {}) => {
    const now = new Date();
    const filter = { libraryId };
    if (search) {
        const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
        filter.$or = [{ title: rx }, { description: rx }];
    }
    if (type) filter.type = type;
    if (sendTo) filter.sendTo = sendTo === 'selected' ? { $in: ['selected', 'specific'] } : sendTo;
    if (pinned === 'true' || pinned === true) filter.isPinned = true;
    if (from || to) {
        filter.startDate = {};
        if (from) filter.startDate.$gte = DATE_ONLY.test(String(from)) ? startOfDayIST(new Date(from)) : new Date(from);
        if (to) filter.startDate.$lte = DATE_ONLY.test(String(to)) ? endOfDayIST(new Date(to)) : new Date(to);
    }
    if (status === 'inactive') filter.isActive = false;
    else if (status === 'active') Object.assign(filter, timeFilter(now));
    else if (status === 'scheduled') Object.assign(filter, { isActive: true, startDate: { $gt: now } });
    else if (status === 'expired') Object.assign(filter, { isActive: true, endDate: { $lte: now } });

    if (scope.branchId) filter.$and = [...(filter.$and || []), { $or: [{ branchId: null }, scope] }];

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const lib = new mongoose.Types.ObjectId(String(libraryId));
    const [rows, totalResults, [agg]] = await Promise.all([
        Notice.find(filter).select('-seenBy').sort(NOTICE_SORTS[sort] || NOTICE_SORTS.pinned).skip((p - 1) * l).limit(l).lean(),
        Notice.countDocuments(filter),
        Notice.aggregate([{ $match: { libraryId: lib } }, { $group: {
            _id: null, total: { $sum: 1 }, totalViews: { $sum: '$views' },
            pinned: { $sum: { $cond: ['$isPinned', 1, 0] } },
            inactive: { $sum: { $cond: ['$isActive', 0, 1] } },
            expired: { $sum: { $cond: [{ $and: ['$isActive', { $ne: ['$endDate', null] }, { $lte: ['$endDate', now] }] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $and: ['$isActive', { $gt: ['$startDate', now] }] }, 1, 0] } }
        } }])
    ]);
    const summary = agg
        ? { total: agg.total, totalViews: agg.totalViews, pinned: agg.pinned, inactive: agg.inactive, expired: agg.expired, scheduled: agg.scheduled,
            active: agg.total - agg.inactive - agg.expired - agg.scheduled }
        : { total: 0, totalViews: 0, pinned: 0, inactive: 0, expired: 0, scheduled: 0, active: 0 };
    return {
        results: rows.map((n) => ({ ...n, status: statusOf(n, now) })),
        page: p, limit: l, totalResults, summary
    };
};

const getNoticeById = async (id, libraryId) => {
    assertId(id);
    return Notice.findOne({ _id: id, libraryId }).select('-seenBy').populate('targetStudents', 'name mobile');
};

const updateNotice = async (id, libraryId, body, file) => {
    assertId(id);
    const existing = await Notice.findOne({ _id: id, libraryId });
    if (!existing) return null;

    const set = pick(body, ['title', 'description', 'type', 'isPinned', 'showOnWebsite', 'isActive', 'targetStudents', 'targetBranchIds', 'targetPlanIds', 'branchId']); // branchId validated by the controller
    if (body.sendTo) set.sendTo = normAudience(body.sendTo);
    if (body.startDate) { set.startDate = new Date(body.startDate); set.publishDate = set.startDate; }
    if (body.endDate !== undefined || body.expiryDate) {
        const end = body.endDate || body.expiryDate;
        set.endDate = end ? new Date(end) : null;
    }
    const merged = { ...existing.toObject(), ...set };
    checkDates(merged.startDate, merged.endDate);
    await validateTargets(libraryId, merged);
    if (merged.sendTo !== 'selected') set.targetStudents = [];
    if (merged.sendTo !== 'branch') set.targetBranchIds = [];
    if (merged.sendTo !== 'membershipGroup') set.targetPlanIds = [];

    if (file) {
        if (file.mediaKind !== 'image') throw new ApiError(400, 'Notice attachment must be an image');
        set.imageUrl = file.path;
    } else if (body.removeImage === true) {
        set.imageUrl = '';
    }
    if (set.isActive === true && !existing.isActive) set.publishedAt = new Date();
    return Notice.findOneAndUpdate({ _id: id, libraryId }, { $set: set }, { new: true, runValidators: true }).select('-seenBy');
};

// Publish / unpublish. Publishing a never-delivered notice delivers it (once).
const setPublished = async (id, libraryId, published) => {
    assertId(id);
    const notice = await Notice.findOneAndUpdate(
        { _id: id, libraryId },
        { $set: { isActive: published, ...(published ? { publishedAt: new Date() } : {}) } },
        { new: true }
    ).select('-seenBy');
    if (notice && published) deliverOnce(notice._id).catch(() => {});
    return notice;
};

const deleteNotice = async (id, libraryId) => {
    assertId(id);
    return Notice.findOneAndDelete({ _id: id, libraryId });
};

// ─── Student operations ──────────────────────────────────────────────────────
// Filter of notices addressed to this student
const audienceFilter = (student) => {
    // Branch-specific notices only reach that branch's students (branchId null = every branch)
    const branchOk = branchVisibility(student.branchId);
    const or = [
        { sendTo: 'all' },
        { sendTo: { $in: ['selected', 'specific'] }, targetStudents: student._id }
    ];
    if (student.branchId) or.push({ sendTo: 'branch', targetBranchIds: student.branchId });
    if (student.planId && student.planStatus === 'active') or.push({ sendTo: 'membershipGroup', targetPlanIds: student.planId });
    if (student.planStatus === 'active') or.push({ sendTo: 'premium' });
    return { $and: [{ $or: or }, branchOk] };
};

const getActiveStudentNotices = async (student) => {
    const libraryId = student.libraryId && student.libraryId._id ? student.libraryId._id : student.libraryId;
    // Other students' identities (targetStudents / seenBy) are never exposed
    return Notice.find({ $and: [liveFilter(libraryId), audienceFilter(student)] })
        .select('-targetStudents -seenBy -targetBranchIds -targetPlanIds -createdBy -notifiedAt')
        .sort({ isPinned: -1, createdAt: -1 }).lean();
};

const incrementViews = async (id, student) => {
    assertId(id);
    const libraryId = student.libraryId && student.libraryId._id ? student.libraryId._id : student.libraryId;
    const visible = await Notice.exists({ _id: id, $and: [liveFilter(libraryId), audienceFilter(student)] });
    if (!visible) throw new ApiError(404, 'Notice not found');
    // Unique per student
    await Notice.updateOne({ _id: id, libraryId, seenBy: { $ne: student._id } }, { $inc: { views: 1 }, $addToSet: { seenBy: student._id } });
    return { viewed: true };
};

module.exports = {
    createNotice, queryNotices, getNoticeById, updateNotice, setPublished, deleteNotice,
    getActiveStudentNotices, incrementViews, publishDueNotices, deliverOnce, resolveAudienceStudentIds
};

// ---- Live dashboards (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
module.exports.createNotice = realtime.after(module.exports.createNotice, ([libraryId], n) => realtime.noticeCreated({ libraryId, branchId: n && n.branchId, noticeId: n && n._id }));
