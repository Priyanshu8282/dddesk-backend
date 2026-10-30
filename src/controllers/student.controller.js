const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const studentService = require('../services/student.service');
const Student = require('../models/student.model');
const { tenantId } = require('../middlewares/access.middleware');
const { branchFilter, branchForCreate, assertBranchAccess, branchVisibility } = require('../utils/branchScope');

const lib = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context is required');
    return id;
};

const ok = (res, message, data, extra = {}, code = 200) =>
    res.status(code).json({ success: true, message, data, ...extra });

/** Pull uploaded file paths into the body (profile image, aadhaar images, extra documents). */
const applyUploads = (req, data) => {
    if (req.files && req.files.profileImage) data.profileImage = req.files.profileImage[0].path;
    if (req.files && req.files.aadhaarCardImage) data.aadhaarCardImage = req.files.aadhaarCardImage.map((f) => f.path);
    if (data.profileImage === 'null' || data.profileImage === '') data.profileImage = null;
    return data;
};

// ---------------------------------------------------------------------------
// Admin / staff
// ---------------------------------------------------------------------------
exports.createStudent = catchAsync(async (req, res) => {
    const data = applyUploads(req, { ...req.body });
    // Extra uploaded documents (type from body.documentType)
    if (req.files && req.files.documents) {
        data.documents = req.files.documents.map((f) => ({
            type: req.body.documentType || 'other', name: f.originalname, url: f.path, uploadedAt: new Date()
        }));
    }
    data.branchId = await branchForCreate(req, lib(req), data.branchId);
    const result = await studentService.registerStudent(lib(req), data, req);
    ok(res, 'Student registered successfully', result.student, {
        credentials: result.credentials,
        seat: result.seat,
        pendingCharge: result.pendingCharge,
        warnings: result.warnings
    }, 201);
});

exports.importStudents = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const { rows, dryRun, branchId, consentConfirmed } = req.body;
    const branch = await branchForCreate(req, libraryId, branchId);
    const result = await studentService.importStudents(libraryId, rows, req, { dryRun: !!dryRun, branchId: branch, consentConfirmed: !!consentConfirmed });
    const { summary } = result;
    ok(res, dryRun
        ? `${summary.valid} of ${summary.total} rows are ready to import`
        : `${summary.created} student${summary.created === 1 ? '' : 's'} imported`, result.results, { summary, dryRun: result.dryRun }, 200);
});

exports.getAllStudents =catchAsync(async (req, res) => {
    const result = await studentService.queryStudents(lib(req), req.query, branchFilter(req));
    res.status(200).json({
        success: true,
        message: 'Students retrieved successfully',
        ...result,
        students: result.results,
        data: result.results,
        total: result.totalResults
    });
});

exports.exportStudents = catchAsync(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="students-${new Date().toISOString().slice(0, 10)}.csv"`);
    await studentService.exportStudentsCsv(lib(req), req.query, branchFilter(req), (chunk) => new Promise((resolve) => (res.write(chunk) ? resolve() : res.once('drain', resolve))));
    res.end();
});

exports.getStudentById = catchAsync(async (req, res) => {
    const student = await require('../utils/securityEvent').flagOnMiss(req, require('../models/student.model'), req.params.id, 'Student',
        () => studentService.getStudentById(req.params.id, lib(req)));
    ok(res, 'Student retrieved successfully', student);
});

exports.updateStudent = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const data = applyUploads(req, { ...req.body });
    if (req.files && req.files.documents) {
        const existing = await Student.findOne({ _id: req.params.id, libraryId }).select('documents');
        if (!existing) throw new ApiError(404, 'Student not found');
        data.documents = [
            ...(existing.documents || []).map((d) => d.toObject()),
            ...req.files.documents.map((f) => ({ type: req.body.documentType || 'other', name: f.originalname, url: f.path, uploadedAt: new Date() }))
        ];
    }
    if (data.branchId) assertBranchAccess(req, data.branchId);
    const student = await studentService.updateStudentById(req.params.id, libraryId, data, req);
    audit(req, 'student.update', 'Student', req.params.id, { fields: Object.keys(req.body || {}) });
    ok(res, 'Student updated successfully', student);
});

exports.deleteStudent = catchAsync(async (req, res) => {
    await studentService.deleteStudentById(req.params.id, lib(req), req);
    res.status(200).json({ success: true, message: 'Student archived successfully' });
});

// DPDP right to erasure (owner only): wipes personal data, keeps financial records
exports.eraseStudent = catchAsync(async (req, res) => {
    const result = await studentService.eraseStudent(req.params.id, lib(req), { reason: req.body.reason }, req);
    ok(res, 'Student personal data erased. Payment records were kept.', result);
});

// DPDP right to access: everything held about the student, as a JSON download
exports.exportStudentData = catchAsync(async (req, res) => {
    const data = await studentService.exportStudentData(req.params.id, lib(req), req);
    res.setHeader('Content-Disposition', `attachment; filename="student-data-${req.params.id}.json"`);
    ok(res, 'Student data exported', data);
});

// Archived students whose retention period has passed (review, then erase)
exports.retentionCandidates = catchAsync(async (req, res) => {
    const data = await studentService.listRetentionCandidates(lib(req), { days: req.query.days });
    ok(res, 'Retention candidates retrieved', data.students, { retentionDays: data.retentionDays, cutoff: data.cutoff, count: data.count });
});

exports.assignPlan = catchAsync(async (req, res) => {
    const result = await studentService.assignPlan(req.params.id, lib(req), req.body, req);
    ok(res, 'Plan assigned successfully', result.student, { pendingCharge: result.pendingCharge, charge: result.charge, amount: result.amount });
});

exports.markAsPaid = catchAsync(async (req, res) => {
    const body = { ...req.body, requestId: req.body.requestId || req.get('Idempotency-Key') || undefined };
    const result = await studentService.markAsPaid(req.params.id, lib(req), body, req);
    ok(res, result.replay ? 'Payment already recorded' : 'Payment recorded and plan activated', result.student, {
        membership: result.membership, payment: result.payment, paymentRecorded: result.paymentRecorded, replay: !!result.replay
    });
});

exports.changePlan = catchAsync(async (req, res) => {
    const body = { ...req.body, requestId: req.body.requestId || req.get('Idempotency-Key') || undefined };
    const result = await studentService.changePlan(req.params.id, lib(req), body, req);
    ok(res, 'Plan changed successfully', result.student, {
        membership: result.membership, pendingCharge: result.pendingCharge, charge: result.charge,
        payment: result.payment, proration: result.proration, warnings: result.warnings
    });
});

exports.renew = catchAsync(async (req, res) => {
    const body = { ...req.body, requestId: req.body.requestId || req.get('Idempotency-Key') || undefined };
    const result = await studentService.renewMembership(req.params.id, lib(req), body, req);
    ok(res, 'Membership renewed successfully', result.student, {
        membership: result.membership, pendingCharge: result.pendingCharge, charge: result.charge, payment: result.payment, seatNote: result.seatNote
    });
});

exports.pauseMembership = catchAsync(async (req, res) => {
    const student = await studentService.pauseMembership(req.params.id, lib(req), req.body, req);
    ok(res, 'Membership paused', student);
});

exports.resumeMembership = catchAsync(async (req, res) => {
    const result = await studentService.resumeMembership(req.params.id, lib(req), req.body, req);
    ok(res, 'Membership resumed', result.student, { pausedDays: result.pausedDays, creditedDays: result.creditedDays, seatNote: result.seatNote });
});

exports.extendMembership = catchAsync(async (req, res) => {
    const student = await studentService.extendMembership(req.params.id, lib(req), req.body, req);
    ok(res, 'Membership extended', student);
});

exports.getMemberships = catchAsync(async (req, res) => {
    const list = await studentService.getMemberships(req.params.id, lib(req));
    ok(res, 'Membership history retrieved successfully', list);
});

exports.setStatus = catchAsync(async (req, res) => {
    const student = await studentService.setStatus(req.params.id, lib(req), req.body, req);
    ok(res, `Student marked ${req.body.status}`, student);
});

exports.addNote = catchAsync(async (req, res) => {
    const note = await studentService.addNote(req.params.id, lib(req), req.body.text, req);
    ok(res, 'Note added', note, {}, 201);
});

exports.getNotes = catchAsync(async (req, res) => {
    const notes = await studentService.getNotes(req.params.id, lib(req));
    ok(res, 'Notes retrieved successfully', notes);
});

exports.resetPassword = catchAsync(async (req, res) => {
    const credentials = await studentService.resetPassword(req.params.id, lib(req), req);
    ok(res, 'Password reset. Share the temporary password with the student securely; it is shown only once.', credentials);
});

exports.getPaymentHistory = catchAsync(async (req, res) => {
    const payments = await studentService.getStudentPayments(req.params.id, lib(req));
    ok(res, 'Payment history fetched successfully', payments);
});

exports.getLedger = catchAsync(async (req, res) => {
    const data = await studentService.getStudentLedger(req.params.id, lib(req));
    ok(res, 'Student ledger retrieved successfully', data);
});

// ---------------------------------------------------------------------------
// Student portal (own record only)
// ---------------------------------------------------------------------------
exports.getMyProfile = catchAsync(async (req, res) => {
    const student = await Student.findOne({ _id: req.user._id, libraryId: req.libraryId })
        .select('-notes -password -otp -fcmTokens')
        .populate('planId', 'name durationType durationDays price finalPrice');
    if (!student) throw new ApiError(404, 'Student not found');

    // "My library" + "My seat" (spec 17): contact/location and the assigned seat
    const Library = require('../models/library.model');
    const Seat = require('../models/seat.model');
    const Branch = require('../models/branch.model');
    const [library, seat, branch] = await Promise.all([
        Library.findOne({ _id: req.libraryId, isDeleted: { $ne: true } })
            .select('name logo address city state pincode mobile email workingHours weeklyHolidays mapLocation socialLinks rules terms')
            .lean(),
        Seat.findOne({ libraryId: req.libraryId, studentId: student._id, isDeleted: { $ne: true } })
            .select('seatNumber floor room type status').lean(),
        student.branchId ? Branch.findOne({ _id: student.branchId, libraryId: req.libraryId }).select('name address phone').lean() : null
    ]);
    ok(res, 'Profile retrieved successfully', { ...student.toObject(), library, seat, branch });
});

// Student edits only their own contact details (never plan, status, seat or library)
exports.updateMyProfile = catchAsync(async (req, res) => {
    const allowed = ['name', 'email', 'address', 'emergencyContact'];
    const update = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (!Object.keys(update).length) throw new ApiError(400, 'Nothing to update');
    const student = await Student.findOneAndUpdate(
        { _id: req.user._id, libraryId: req.libraryId },
        { $set: update },
        { new: true, runValidators: true }
    ).select('-notes -password -otp -fcmTokens');
    if (!student) throw new ApiError(404, 'Student not found');
    audit(req, 'student.update_own_profile', 'Student', student._id, { fields: Object.keys(update) });
    ok(res, 'Profile updated successfully', student);
});

// Student asks for a renewal; staff completes it (the fee must be collected/credited by the library,
// so a student can never extend their own membership without payment).
exports.requestRenewal = catchAsync(async (req, res) => {
    const student = await Student.findOne({ _id: req.user._id, libraryId: req.libraryId });
    if (!student) throw new ApiError(404, 'Student not found');
    if (['pending', 'paused'].includes(student.planStatus)) {
        throw new ApiError(400, `Cannot request renewal while the membership is ${student.planStatus}`);
    }
    let planName = null;
    const planId = req.body.planId || student.planId;
    if (!planId) throw new ApiError(400, 'No plan to renew. Choose a plan.');
    const Plan = require('../models/plan.model');
    const plan = await Plan.findOne({ _id: planId, libraryId: req.libraryId, isDeleted: { $ne: true } }).select('name allowRenewal isArchived');
    if (!plan) throw new ApiError(404, 'Plan not found');
    if (plan.allowRenewal === false) throw new ApiError(400, `Plan "${plan.name}" does not allow renewal`);
    planName = plan.name;

    const { notifyLibraryAdmins } = require('../services/firebase.service');
    notifyLibraryAdmins(
        req.libraryId,
        'Renewal request',
        `${student.name} wants to renew on "${planName}"${req.body.note ? `: ${req.body.note}` : ''}`,
        { type: 'renewal_request', studentId: String(student._id), planId: String(plan._id) },
        'renewal_request'
    ).catch(() => {});
    audit(req, 'student.renewal_request', 'Student', student._id, { planId: plan._id });
    res.status(202).json({ success: true, message: 'Renewal request sent to the library. They will contact you to complete it.' });
});

// Sign out of every device: tokens issued before now stop working
exports.logoutAll = catchAsync(async (req, res) => {
    await Student.updateOne({ _id: req.user._id, libraryId: req.libraryId }, { $set: { tokensValidAfter: new Date(), fcmTokens: [] } });
    audit(req, 'student.logout_all', 'Student', req.user._id);
    res.status(200).json({ success: true, message: 'Signed out from all devices' });
});

exports.changePassword = catchAsync(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    await studentService.changeStudentPassword(req.user._id, currentPassword, newPassword);
    // a changed password ends every OTHER device's session (this one keeps working)
    await require('../services/session.service').revokeAllForUser(req.user._id, 'password_changed', { exceptSid: req.sessionId });
    res.status(200).json({ success: true, message: 'Password changed successfully' });
});

exports.getDashboard = catchAsync(async (req, res) => {
    const studentId = req.user._id;
    const libraryId = req.libraryId;
    const student = await Student.findOne({ _id: studentId, libraryId }).populate('planId');
    if (!student) throw new ApiError(404, 'Student not found');

    const Attendance = require('../models/attendance.model');
    const Notice = require('../models/notice.model');
    const Banner = require('../models/banner.model');
    const storyService = require('../services/story.service');

    // Distinct attended days since membership start
    const startDate = student.planStartDate || student.joiningDate || new Date();
    const [attended] = await Attendance.aggregate([
        { $match: { studentId: new mongoose.Types.ObjectId(String(studentId)), libraryId: new mongoose.Types.ObjectId(String(libraryId)), status: 'present', date: { $gte: startDate } } },
        { $group: { _id: '$date' } },
        { $count: 'days' }
    ]);
    const presentDays = attended ? attended.days : 0;
    const diffDays = Math.max(1, Math.ceil((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)));
    const presentPercentage = Math.min(100, Math.round((presentDays / diffDays) * 100));

    const plan = student.planId;
    // Pending fee comes from the fee ledger (sum of every open charge, spec 15.4)
    const outstanding = await require('../services/feeLedger.service').getOutstanding(libraryId, studentId)
        .catch(() => ({ totalOutstanding: 0, overdueCount: 0 }));
    const metrics = {
        presentPercentage,
        presentDays,
        absentDays: Math.max(0, diffDays - presentDays),
        totalDays: diffDays,
        feesDue: outstanding.totalOutstanding,
        overdueCount: outstanding.overdueCount,
        planStatus: student.planStatus,
        expiryDate: student.expiryDate,
        daysRemaining: student.expiryDate ? Math.max(0, Math.ceil((new Date(student.expiryDate) - Date.now()) / (1000 * 60 * 60 * 24))) : 0,
        mustChangePassword: !!student.mustChangePassword
    };

    const now = new Date();
    const [notices, banners, stories, recentPayments] = await Promise.all([
        Notice.find({ libraryId, isActive: true, ...branchVisibility(student.branchId) }).sort({ createdAt: -1 }).limit(3),
        Banner.find({ libraryId, isActive: true, startDate: { $lte: now }, endDate: { $gte: now }, ...branchVisibility(student.branchId) }).sort({ startDate: -1 }),
        storyService.getActiveStudentStories(libraryId, studentId, student.branchId).catch(() => []),
        studentService.getStudentPayments(studentId, libraryId).then((p) => p.slice(0, 3)).catch(() => [])
    ]);

    ok(res, 'Student dashboard data retrieved successfully', { metrics, notices, stories, banners, recentPayments });
});
