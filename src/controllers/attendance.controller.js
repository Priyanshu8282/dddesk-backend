const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const catchAsync = require('../utils/catchAsync');
const attendanceService = require('../services/attendance.service');
const Student = require('../models/student.model');
const DailyCode = require('../models/dailyCode.model');
const Attendance = require('../models/attendance.model');
const AttendanceQR = require('../models/attendanceQR.model');

const { notifyLibraryAdmins, notifyStudent } = require('../services/firebase.service');

// ─── Generate rotating QR (Admin endpoint, polls every 60s) ──────────────────
const generateQR = catchAsync(async (req, res) => {
  const libraryId = req.user.libraryId;
  if (!libraryId) {
    return res.status(400).json({ success: false, message: 'Library ID not found on your account' });
  }

  const nonce = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds

  const payload = {
    libraryId: libraryId.toString(),
    nonce,
    type: 'attendance_qr',
    exp: Math.floor(expiresAt.getTime() / 1000)
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET);

  await AttendanceQR.create({ libraryId, token, nonce, expiresAt });

  // Try to generate QR image server-side; fallback to null
  let qrDataUrl = null;
  try {
    const QRCode = require('qrcode');
    qrDataUrl = await QRCode.toDataURL(token, {
      width: 300,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch (_) { /* qrcode package not installed; frontend will handle rendering */ }

  res.status(200).json({
    success: true,
    message: 'QR code generated successfully',
    data: { token, qrDataUrl, expiresAt, expiresIn: 60 }
  });
});

// ─── Scan QR (Student endpoint) ───────────────────────────────────────────────
const scanQR = catchAsync(async (req, res) => {
  const studentId = req.user.id;
  const libraryId = req.user.libraryId;
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'QR token is required' });
  }

  // 1. Verify JWT signature + expiry
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Invalid or expired QR code. Please scan the current QR.' });
  }

  if (decoded.type !== 'attendance_qr') {
    return res.status(400).json({ success: false, message: 'Invalid QR code.' });
  }

  // 2. Library must match
  if (decoded.libraryId !== libraryId.toString()) {
    return res.status(403).json({ success: false, message: 'This QR code belongs to a different library.' });
  }

  // 3. Atomically mark nonce as used – prevents race-condition duplicates
  const qrRecord = await AttendanceQR.findOneAndUpdate(
    { nonce: decoded.nonce, isUsed: false },
    { $set: { isUsed: true, usedBy: studentId, usedAt: new Date() } },
    { new: true }
  );

  if (!qrRecord) {
    return res.status(400).json({ success: false, message: 'This QR code has already been used. Please wait for the next QR.' });
  }

  // 4. Verify student has active plan in this library
  const student = await Student.findById(studentId);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student not found.' });
  }
  if (student.status !== 'active') {
    return res.status(403).json({ success: false, message: 'Your account is not active. Contact the library.' });
  }
  if (student.planStatus !== 'active') {
    return res.status(403).json({ success: false, message: 'No active membership. Please renew your plan.' });
  }
  if (student.expiryDate && new Date(student.expiryDate) < new Date()) {
    return res.status(403).json({ success: false, message: 'Membership expired. Please renew.' });
  }

  // 5. Determine check-in or check-out
  const openSession = await Attendance.findOne({ studentId, checkOut: { $exists: false } });

  let action, attendance;
  if (!openSession) {
    // CHECK IN
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    attendance = await Attendance.create({
      studentId,
      libraryId,
      date: today,
      checkIn: new Date(),
      status: 'present'
    });
    action = 'check-in';

    notifyLibraryAdmins(libraryId, '🟢 Check-In', `${student.name} checked in.`, {}, 'attendance_alert').catch(() => {});
    notifyStudent(studentId, '✅ Checked In', 'You have checked in successfully.', {}, 'attendance_alert').catch(() => {});
  } else {
    // CHECK OUT
    const checkOutTime = new Date();
    const duration = Math.round((checkOutTime - openSession.checkIn) / (1000 * 60));
    openSession.checkOut = checkOutTime;
    openSession.duration = duration;
    await openSession.save();
    attendance = openSession;
    action = 'check-out';

    notifyLibraryAdmins(libraryId, '🔴 Check-Out', `${student.name} checked out. Duration: ${duration} min.`, {}, 'attendance_alert').catch(() => {});
    notifyStudent(studentId, '✅ Checked Out', `Session: ${duration} minutes.`, {}, 'attendance_alert').catch(() => {});
  }

  res.status(200).json({
    success: true,
    message: action === 'check-in' ? 'Checked in successfully' : 'Checked out successfully',
    data: { action, attendance }
  });
});

// ─── Today's attendance list (Admin) ─────────────────────────────────────────
const getToday = catchAsync(async (req, res) => {
  const libraryId = req.user.libraryId;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const search = req.query.search ? req.query.search.trim().toLowerCase() : '';
  const statusFilter = req.query.status ? req.query.status.toUpperCase() : 'ALL';

  const activeStudents = await Student.find({ libraryId, status: 'active' });
  const activeStudentIds = new Set(activeStudents.map(s => s._id.toString()));

  const todayAttendances = await Attendance.find({ libraryId, date: today })
    .populate('studentId', 'name mobile rollNumber profileImage seatNumber');

  const punchedMap = new Map();
  for (const att of todayAttendances) {
    const sid = (att.studentId?._id || att.studentId).toString();
    punchedMap.set(sid, att);
  }

  // Build combined list
  let rows = [];

  // Present / Inside rows
  for (const att of todayAttendances) {
    if (!att.studentId) continue;
    const s = att.studentId;
    const sid = (s._id || s).toString();
    if (!activeStudentIds.has(sid)) continue;
    rows.push({
      _id: att._id.toString(),
      studentId: sid,
      name: s.name || 'Unknown',
      mobile: s.mobile || '',
      rollNumber: s.rollNumber || '',
      profileImage: s.profileImage || null,
      status: att.checkOut ? 'PRESENT' : 'INSIDE',
      checkIn: att.checkIn,
      checkOut: att.checkOut || null,
      duration: att.duration || null,
      date: att.date
    });
  }

  // Absent rows
  for (const s of activeStudents) {
    if (!punchedMap.has(s._id.toString())) {
      rows.push({
        _id: `absent-${s._id}`,
        studentId: s._id.toString(),
        name: s.name,
        mobile: s.mobile || '',
        rollNumber: s.rollNumber || '',
        profileImage: s.profileImage || null,
        status: 'ABSENT',
        checkIn: null,
        checkOut: null,
        duration: null,
        date: today
      });
    }
  }

  // Filter by status
  if (statusFilter !== 'ALL') {
    rows = rows.filter(r => r.status === statusFilter);
  }

  // Search
  if (search) {
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(search) ||
      r.mobile.includes(search) ||
      r.rollNumber.toLowerCase().includes(search)
    );
  }

  const summary = {
    total: activeStudents.length,
    present: todayAttendances.filter(a => a.checkOut).length,
    inside: todayAttendances.filter(a => !a.checkOut).length,
    absent: activeStudents.length - punchedMap.size
  };

  const total = rows.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = rows.slice(start, start + limit);

  res.status(200).json({
    success: true,
    message: "Today's attendance retrieved successfully",
    data: { results: paged, summary, total, totalPages, page }
  });
});

// ─── Currently inside students (Admin) ───────────────────────────────────────
const getActive = catchAsync(async (req, res) => {
  const libraryId = req.user.libraryId;

  const active = await Attendance.find({ libraryId, checkOut: { $exists: false } })
    .populate('studentId', 'name mobile rollNumber profileImage seatNumber')
    .sort({ checkIn: -1 });

  const results = active.map(att => ({
    _id: att._id,
    studentId: att.studentId?._id,
    name: att.studentId?.name || 'Unknown',
    mobile: att.studentId?.mobile || '',
    rollNumber: att.studentId?.rollNumber || '',
    profileImage: att.studentId?.profileImage || null,
    checkIn: att.checkIn,
    minutesInside: Math.round((Date.now() - new Date(att.checkIn).getTime()) / 60000)
  }));

  res.status(200).json({
    success: true,
    message: 'Active students retrieved successfully',
    data: { results, count: results.length }
  });
});

// ─── Manual close (Admin) ─────────────────────────────────────────────────────
const manualClose = catchAsync(async (req, res) => {
  const libraryId = req.user.libraryId;
  const { id } = req.params;
  const { reason, checkOutTime: customTime } = req.body;

  const att = await Attendance.findOne({ _id: id, libraryId, checkOut: { $exists: false } });
  if (!att) {
    return res.status(404).json({ success: false, message: 'No open session found with this ID.' });
  }

  const checkOutTime = customTime ? new Date(customTime) : new Date();
  const duration = Math.round((checkOutTime - att.checkIn) / (1000 * 60));

  att.checkOut = checkOutTime;
  att.duration = duration;
  att.manualClose = true;
  att.manualCloseReason = reason || 'Closed by admin';
  att.manualClosedBy = req.user.id;
  await att.save();

  res.status(200).json({ success: true, message: 'Session closed manually successfully', data: att });
});

// ─── Legacy punchIn (admin-initiated or with daily code) ──────────────────────
const punchIn = catchAsync(async (req, res) => {
  const studentId = req.userType === 'student' ? req.user.id : req.body?.studentId;
  const libraryId = req.user.libraryId;

  const student = await Student.findById(studentId);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student not found' });
  }

  if (student.planStatus !== 'active') {
    return res.status(400).json({ success: false, message: 'Active plan required to punch in' });
  }

  if (req.userType === 'student') {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Daily code is required' });
    }
    const dateStr = new Date().toISOString().split('T')[0];
    const dailyCode = await DailyCode.findOne({ studentId, libraryId, date: dateStr });
    if (!dailyCode || dailyCode.code.toUpperCase() !== code.toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Invalid daily code' });
    }
  }

  const attendance = await attendanceService.punchIn(studentId, libraryId);

  if (student) {
    notifyLibraryAdmins(libraryId, '🟢 Attendance: Punch In', `${student.name} punched in successfully.`, {}, 'attendance_alert').catch(() => {});
    notifyStudent(studentId, '✅ Attendance Marked Successfully', 'You have punched in successfully.', {}, 'attendance_alert').catch(() => {});
  }

  res.status(201).json({ success: true, message: 'Punched in successfully', data: attendance });
});

// ─── Legacy punchOut ─────────────────────────────────────────────────────────
const punchOut = catchAsync(async (req, res) => {
  const studentId = req.userType === 'student' ? req.user.id : req.body?.studentId;

  const student = await Student.findById(studentId);
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student not found' });
  }

  if (student.planStatus !== 'active') {
    return res.status(400).json({ success: false, message: 'Active plan required to punch out' });
  }

  if (req.userType === 'student') {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Daily code is required' });
    }
    const libraryId = req.user.libraryId;
    const dateStr = new Date().toISOString().split('T')[0];
    const dailyCode = await DailyCode.findOne({ studentId, libraryId, date: dateStr });
    if (!dailyCode || dailyCode.code.toUpperCase() !== code.toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Invalid daily code' });
    }
  }

  const attendance = await attendanceService.punchOut(studentId);

  if (student && attendance.libraryId) {
    notifyLibraryAdmins(attendance.libraryId, '🔴 Attendance: Punch Out', `${student.name} punched out successfully.`, {}, 'attendance_alert').catch(() => {});
    notifyStudent(studentId, '✅ Attendance Marked Successfully', 'You have punched out successfully.', {}, 'attendance_alert').catch(() => {});
  }

  res.status(200).json({ success: true, message: 'Punched out successfully', data: attendance });
});

// ─── Legacy list (kept for backward compat) ──────────────────────────────────
const getAttendance = catchAsync(async (req, res) => {
  const libraryId = req.user.libraryId;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  const dateFilter = {};
  if (req.query.date) {
    const d = new Date(req.query.date);
    d.setHours(0, 0, 0, 0);
    dateFilter.date = d;
  } else if (req.query.startDate || req.query.endDate) {
    dateFilter.date = {};
    if (req.query.startDate) {
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      dateFilter.date.$gte = start;
    }
    if (req.query.endDate) {
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.date.$lte = end;
    }
  }

  const filter = { libraryId, ...dateFilter };
  if (req.query.studentId) filter.studentId = req.query.studentId;

  const result = await attendanceService.queryAttendance(filter, { page, limit });

  res.status(200).json({
    success: true,
    message: 'Attendance records fetched successfully',
    data: result
  });
});

module.exports = {
  generateQR,
  scanQR,
  getToday,
  getActive,
  manualClose,
  punchIn,
  punchOut,
  getAttendance
};
