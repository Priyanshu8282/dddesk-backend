const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const attendanceService = require('../services/attendance.service');
const Student = require('../models/student.model');
const Attendance = require('../models/attendance.model');
const { branchFilter, assertBranchAccess, isValidId } = require('../utils/branchScope');

// Branch-limited staff may only act on students / records of their own branches
const guardStudent = async (req, studentId) => {
  if (req.userType !== 'staff' || !isValidId(studentId)) return;
  const s = await Student.findOne({ _id: studentId, libraryId: req.libraryId }).select('branchId').lean();
  if (s) assertBranchAccess(req, s.branchId);
};
const guardRecord = async (req, id) => {
  if (req.userType !== 'staff' || !isValidId(id)) return;
  const a = await Attendance.findOne({ _id: id, libraryId: req.libraryId }).select('branchId').lean();
  if (a) assertBranchAccess(req, a.branchId);
};

// ─── QR (staff displays it; students scan it) ────────────────────────────────
const generateQR = catchAsync(async (req, res) => {
  const libraryId = req.libraryId;
  if (!libraryId) throw new ApiError(400, 'Library not found on your account');
  const data = await attendanceService.generateQR(libraryId);
  ApiResponse.ok(res, data, 'QR code generated successfully');
});

const scanQR = catchAsync(async (req, res) => {
  const result = await attendanceService.studentScan({
    student: req.user, library: req.library, token: req.body.token, source: 'qr'
  });
  ApiResponse.ok(res, result, result.action === 'check-in' ? 'Checked in successfully' : 'Checked out successfully');
});

const selfCheck = catchAsync(async (req, res) => {
  const result = await attendanceService.studentScan({
    student: req.user, library: req.library, token: req.body.token, action: req.body.action, source: 'self'
  });
  ApiResponse.ok(res, result, result.action === 'check-in' ? 'Checked in successfully' : 'Checked out successfully');
});

// ─── Student: own history + percentage ───────────────────────────────────────
const getMy = catchAsync(async (req, res) => {
  const data = await attendanceService.myHistory({ student: req.user, library: req.library, query: req.query });
  ApiResponse.ok(res, data, 'Attendance history retrieved successfully');
});

// ─── Staff live views ────────────────────────────────────────────────────────
const getToday = catchAsync(async (req, res) => {
  const data = await attendanceService.getToday(req.libraryId, req.query, branchFilter(req));
  ApiResponse.ok(res, data, "Today's attendance retrieved successfully");
});

const getActive = catchAsync(async (req, res) => {
  const data = await attendanceService.getActive(req.libraryId, branchFilter(req));
  ApiResponse.ok(res, data, 'Active students retrieved successfully');
});

const getAttendance = catchAsync(async (req, res) => {
  const data = await attendanceService.queryAttendance(req.libraryId, req.query, branchFilter(req));
  ApiResponse.ok(res, data, 'Attendance records fetched successfully');
});

// ─── Staff actions ───────────────────────────────────────────────────────────
const manualClose = catchAsync(async (req, res) => {
  await guardRecord(req, req.params.id);
  const att = await attendanceService.manualClose({
    id: req.params.id, libraryId: req.libraryId, library: req.library,
    reason: req.body?.reason, checkOutTime: req.body?.checkOutTime, userId: req.user._id
  });
  audit(req, 'attendance.manual_close', 'Attendance', att._id, { reason: att.manualCloseReason });
  ApiResponse.ok(res, att, 'Session closed manually successfully');
});

const markManual = catchAsync(async (req, res) => {
  const { studentId, time } = req.body;
  await guardStudent(req, studentId);
  const type = req.body.type || (req.body.action === 'check-out' ? 'out' : 'in');
  const result = await attendanceService.manualMark({
    libraryId: req.libraryId, library: req.library, studentId, type, time, markedBy: req.user._id
  });
  audit(req, `attendance.manual_${type}`, 'Attendance', result.attendance._id, { studentId });
  ApiResponse.created(res, result, type === 'in' ? 'Checked in successfully' : 'Checked out successfully');
});

// Legacy endpoints: staff only, delegate to the manual flow
const punchIn = (req, res, next) => { req.body.type = 'in'; return markManual(req, res, next); };
const punchOut = (req, res, next) => { req.body.type = 'out'; return markManual(req, res, next); };

const correct = catchAsync(async (req, res) => {
  await guardRecord(req, req.params.id);
  const att = await attendanceService.correctSession({
    id: req.params.id, libraryId: req.libraryId, library: req.library, body: req.body, userId: req.user._id
  });
  audit(req, 'attendance.correct', 'Attendance', att._id, { reason: req.body.reason });
  ApiResponse.ok(res, att, 'Attendance corrected successfully');
});

const markLeave = catchAsync(async (req, res) => {
  await guardStudent(req, req.body.studentId);
  const att = await attendanceService.markLeave({
    libraryId: req.libraryId, studentId: req.body.studentId, date: req.body.date,
    reason: req.body.reason, userId: req.user._id
  });
  audit(req, 'attendance.leave', 'Attendance', att._id, { studentId: req.body.studentId, date: req.body.date });
  ApiResponse.created(res, att, 'Leave marked successfully');
});

// ─── Reports ─────────────────────────────────────────────────────────────────
const studentSummary = catchAsync(async (req, res) => {
  await guardStudent(req, req.params.id);
  const student = await attendanceService.getStudentInLibrary(req.params.id, req.libraryId);
  const data = await attendanceService.studentSummary({ student, library: req.library, query: req.query });
  ApiResponse.ok(res, data, 'Attendance summary retrieved successfully');
});

const percentage = catchAsync(async (req, res) => {
  const data = await attendanceService.percentageReport({ libraryId: req.libraryId, library: req.library, query: req.query, scope: branchFilter(req) });
  ApiResponse.ok(res, data, 'Attendance percentage retrieved successfully');
});

module.exports = {
  generateQR, scanQR, selfCheck, getMy, getToday, getActive, getAttendance,
  manualClose, markManual, punchIn, punchOut, correct, markLeave, studentSummary, percentage
};
