/**
 * Account deletion requests (student self-service, library owner self-service). Nothing is deleted
 * automatically: a student's request only takes effect once staff/owner approves it (which runs the
 * existing DPDP erase flow), and a library's request is just queued for a superadmin to review and act
 * on manually - closing/erasing a whole tenant is deliberately left as a separate, human-driven action.
 */
const mongoose = require('mongoose');
const DeletionRequest = require('../models/deletionRequest.model');
const Admin = require('../models/admin.model');
const Notification = require('../models/notification.model');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

const clampPaging = (q = {}) => ({
    page: Math.max(1, parseInt(q.page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20))
});

const assertId = (id) => { if (!isValidId(id)) throw new ApiError(400, 'Invalid request ID'); };

// ---------------------------------------------------------------------------
// Student self-service: request only. Approval runs the existing DPDP erase flow.
// ---------------------------------------------------------------------------
const requestStudentDeletion = async (studentId, libraryId, reason, req) => {
    const existing = await DeletionRequest.findOne({ type: 'student', requestedBy: studentId, status: 'pending' });
    if (existing) throw new ApiError(409, 'You already have a pending account deletion request');
    const request = await DeletionRequest.create({
        type: 'student', libraryId, requestedBy: studentId, requestedByModel: 'Student', reason: String(reason || '').trim()
    });
    try {
        const { notifyEvent } = require('./notification.service');
        await notifyEvent('system-alert', libraryId, {
            toAdmins: true,
            title: 'Account deletion request',
            message: 'A student has requested their account be deleted. Review it under Students > Deletion requests.',
            data: { deletionRequestId: String(request._id) }
        });
    } catch (e) { /* notification is best-effort */ }
    if (req) audit(req, 'deletionRequest.student.create', 'DeletionRequest', request._id, {});
    return request;
};

const getMyStudentRequest = async (studentId) =>
    DeletionRequest.findOne({ type: 'student', requestedBy: studentId }).sort({ createdAt: -1 });

const cancelMyStudentRequest = async (studentId, req) => {
    const request = await DeletionRequest.findOneAndUpdate(
        { type: 'student', requestedBy: studentId, status: 'pending' },
        { $set: { status: 'cancelled' } }, { new: true }
    );
    if (!request) throw new ApiError(404, 'No pending deletion request to cancel');
    if (req) audit(req, 'deletionRequest.student.cancel', 'DeletionRequest', request._id, {});
    return request;
};

const listStudentRequests = async (libraryId, query) => {
    const { page, limit } = clampPaging(query);
    const filter = { type: 'student', libraryId };
    if (query.status) filter.status = query.status;
    const [results, totalResults] = await Promise.all([
        DeletionRequest.find(filter).populate('requestedBy', 'name mobile registrationNumber')
            .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        DeletionRequest.countDocuments(filter)
    ]);
    return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

const loadStudentRequest = async (id, libraryId) => {
    assertId(id);
    const request = await DeletionRequest.findOne({ _id: id, type: 'student', libraryId });
    if (!request) throw new ApiError(404, 'Deletion request not found');
    return request;
};

const approveStudentRequest = async (id, libraryId, req) => {
    const request = await loadStudentRequest(id, libraryId);
    if (request.status !== 'pending') throw new ApiError(400, `This request is already ${request.status}`);
    const studentService = require('./student.service');
    await studentService.eraseStudent(request.requestedBy, libraryId, { reason: request.reason || 'Approved account deletion request' }, req);
    request.status = 'approved';
    request.reviewedBy = req?.user?._id;
    request.reviewedAt = new Date();
    await request.save();
    if (req) audit(req, 'deletionRequest.student.approve', 'DeletionRequest', request._id, {});
    return request;
};

const rejectStudentRequest = async (id, libraryId, note, req) => {
    const request = await loadStudentRequest(id, libraryId);
    if (request.status !== 'pending') throw new ApiError(400, `This request is already ${request.status}`);
    request.status = 'rejected';
    request.reviewNote = String(note || '').trim();
    request.reviewedBy = req?.user?._id;
    request.reviewedAt = new Date();
    await request.save();
    try {
        const { notifyEvent } = require('./notification.service');
        await notifyEvent('system-alert', libraryId, {
            studentId: request.requestedBy,
            title: 'Account deletion request declined',
            message: request.reviewNote || 'Your account deletion request was declined. Contact your library if you have questions.',
        });
    } catch (e) { /* best-effort */ }
    if (req) audit(req, 'deletionRequest.student.reject', 'DeletionRequest', request._id, {});
    return request;
};

// ---------------------------------------------------------------------------
// Library owner self-service: request only. A superadmin reviews it manually; nothing is auto-deleted.
// ---------------------------------------------------------------------------
const requestLibraryDeletion = async (libraryId, adminId, reason, req) => {
    const existing = await DeletionRequest.findOne({ type: 'library', libraryId, status: 'pending' });
    if (existing) throw new ApiError(409, 'A deletion request for this account is already pending review');
    const request = await DeletionRequest.create({
        type: 'library', libraryId, requestedBy: adminId, requestedByModel: 'Admin', reason: String(reason || '').trim()
    });
    try {
        const superAdmins = await Admin.find({ userType: 'superadmin', status: true, isDeleted: { $ne: true } }).select('_id').lean();
        if (superAdmins.length) {
            await Notification.insertMany(superAdmins.map((a) => ({
                recipientId: a._id, recipientType: 'Admin', type: 'deletion_request', event: 'library-deletion-request',
                title: 'Library account deletion request', message: 'A library owner has requested their account be deleted.',
                data: { deletionRequestId: String(request._id), libraryId: String(libraryId) },
                deliveries: [{ channel: 'inapp', status: 'sent' }]
            })));
        }
    } catch (e) { console.error('[deletionRequest] notify superadmins failed:', e.message); }
    if (req) audit(req, 'deletionRequest.library.create', 'DeletionRequest', request._id, {});
    return request;
};

const getMyLibraryRequest = async (libraryId) =>
    DeletionRequest.findOne({ type: 'library', libraryId }).sort({ createdAt: -1 });

const cancelMyLibraryRequest = async (libraryId, req) => {
    const request = await DeletionRequest.findOneAndUpdate(
        { type: 'library', libraryId, status: 'pending' },
        { $set: { status: 'cancelled' } }, { new: true }
    );
    if (!request) throw new ApiError(404, 'No pending deletion request to cancel');
    if (req) audit(req, 'deletionRequest.library.cancel', 'DeletionRequest', request._id, {});
    return request;
};

// Superadmin: queue of every library's deletion request
const listLibraryRequests = async (query) => {
    const { page, limit } = clampPaging(query);
    const filter = { type: 'library' };
    if (query.status) filter.status = query.status;
    const [results, totalResults] = await Promise.all([
        DeletionRequest.find(filter).populate('libraryId', 'name email isDeleted status')
            .populate('requestedBy', 'name email mobile')
            .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        DeletionRequest.countDocuments(filter)
    ]);
    return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

// Superadmin: record their decision. This never deletes/suspends anything by itself - closing or
// erasing the tenant, if that's the outcome, is a deliberate separate action via the existing library
// management tools, so a human always makes that call explicitly.
const reviewLibraryRequest = async (id, status, note, req) => {
    assertId(id);
    if (!['approved', 'rejected'].includes(status)) throw new ApiError(400, 'Status must be approved or rejected');
    const request = await DeletionRequest.findOne({ _id: id, type: 'library' });
    if (!request) throw new ApiError(404, 'Deletion request not found');
    if (request.status !== 'pending') throw new ApiError(400, `This request is already ${request.status}`);
    request.status = status;
    request.reviewNote = String(note || '').trim();
    request.reviewedBy = req?.user?._id;
    request.reviewedAt = new Date();
    await request.save();
    if (req) audit(req, `deletionRequest.library.${status}`, 'DeletionRequest', request._id, {});
    return request;
};

module.exports = {
    requestStudentDeletion, getMyStudentRequest, cancelMyStudentRequest, listStudentRequests,
    approveStudentRequest, rejectStudentRequest,
    requestLibraryDeletion, getMyLibraryRequest, cancelMyLibraryRequest, listLibraryRequests, reviewLibraryRequest,
};
