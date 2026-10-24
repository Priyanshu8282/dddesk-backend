// Safe publish helpers. Every function:
//  1. drops the cached dashboard summaries of the affected library / platform (works with or without sockets), then
//  2. emits to the right rooms when the socket server is running, and
//  3. never throws and never blocks (fire-and-forget), so business code can call it without a try/catch.
// Payloads carry counters and ids only, never names, mobiles or other personal data.
const rooms = require('./rooms');

let io = null;
const setIo = (instance) => { io = instance; };
const isEnabled = () => !!io;

const LIB_WIDGETS_STUDENT = ['kpis', 'recentStudents', 'attendanceToday', 'membershipExpiring'];
const PLATFORM_STUDENT = ['kpis', 'studentGrowth', 'topLibraries'];
const MONEY_WIDGETS = ['feesCollection'];

const quiet = (fn) => {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* realtime must never break business logic */ }
};

const summary = () => require('../services/dashboardSummary.service');
const at = () => new Date().toISOString();

const libraryTargets = (libraryId, branchId) => {
  const lid = String(libraryId);
  const normal = [rooms.lib(lid)];
  const fees = [rooms.libFees(lid)];
  if (branchId) { normal.push(rooms.branch(lid, branchId)); fees.push(rooms.branchFees(lid, branchId)); }
  return { normal, fees };
};

/** dashboard:invalidate to a library. The money widget names only go to users who may see fees. */
const invalidateLibrary = (libraryId, branchId, widgets) => {
  if (!io) return;
  const { normal, fees } = libraryTargets(libraryId, branchId);
  const plain = widgets.filter((w) => !MONEY_WIDGETS.includes(w));
  io.to(fees).emit('dashboard:invalidate', { scope: 'library', widgets, at: at() });
  if (plain.length) io.to(normal).except(fees).emit('dashboard:invalidate', { scope: 'library', widgets: plain, at: at() });
};

const invalidatePlatform = (widgets) => {
  if (!io) return;
  io.to(rooms.SUPER).emit('dashboard:invalidate', { scope: 'platform', widgets, at: at() });
};

const toLibrary = (libraryId, branchId, event, data) => {
  if (!io) return;
  io.to(libraryTargets(libraryId, branchId).normal).emit(event, data);
};

const toSuper = (event, data) => { if (io) io.to(rooms.SUPER).emit(event, data); };

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
exports.studentCreated = ({ libraryId, branchId = null } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId); summary().invalidatePlatform();
  toLibrary(libraryId, branchId, 'student:created', { count: 1 });
  toLibrary(libraryId, branchId, 'kpi:update', { key: 'totalStudents', value: null, delta: 1 });
  invalidateLibrary(libraryId, branchId, LIB_WIDGETS_STUDENT);
  toSuper('kpi:update', { key: 'totalStudents', value: null, delta: 1 });
  invalidatePlatform(PLATFORM_STUDENT);
});

/** kind: 'deleted' | 'status' | 'updated' | 'plan' */
exports.studentChanged = ({ libraryId, branchId = null, kind = 'updated' } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId); summary().invalidatePlatform();
  if (kind === 'deleted') {
    toLibrary(libraryId, branchId, 'kpi:update', { key: 'totalStudents', value: null, delta: -1 });
    toSuper('kpi:update', { key: 'totalStudents', value: null, delta: -1 });
  }
  invalidateLibrary(libraryId, branchId, LIB_WIDGETS_STUDENT);
  invalidatePlatform(PLATFORM_STUDENT);
});

// ---------------------------------------------------------------------------
// Attendance (counters are read only when sockets are running)
// ---------------------------------------------------------------------------
exports.attendanceChanged = ({ libraryId, branchId = null } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId);
  if (!io) return;
  invalidateLibrary(libraryId, branchId, ['attendanceToday']);
  return (async () => {
    const mongoose = require('mongoose');
    const Attendance = require('../models/attendance.model');
    const Student = require('../models/student.model');
    const { startOfDayIST, endOfDayIST } = require('../utils/time');
    const libId = new mongoose.Types.ObjectId(String(libraryId));
    const scope = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};
    const now = new Date();
    const [present, insideNow, total] = await Promise.all([
      Attendance.distinct('studentId', { libraryId: libId, ...scope, date: { $gte: startOfDayIST(now), $lte: endOfDayIST(now) }, status: 'present' }),
      Attendance.countDocuments({ libraryId: libId, ...scope, open: true }),
      Student.countDocuments({ libraryId: libId, ...scope, isDeleted: false, status: 'active', planStatus: 'active' }),
    ]);
    toLibrary(libraryId, branchId, 'attendance:checkin', { present: present.length, total, insideNow });
  })();
});

// ---------------------------------------------------------------------------
// Money (library fees): only users with fees.view receive these
// ---------------------------------------------------------------------------
/** kind: 'collection' | 'refund'; amount is positive rupees */
exports.paymentChanged = ({ libraryId, branchId = null, amount = 0, kind = 'collection' } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId);
  if (!io) return;
  io.to(libraryTargets(libraryId, branchId).fees)
    .emit('payment:received', { amount: Math.abs(Number(amount) || 0), count: 1, kind });
  io.to(libraryTargets(libraryId, branchId).fees)
    .emit('dashboard:invalidate', { scope: 'library', widgets: ['kpis', 'feesCollection'], at: at() });
});

/** a charge was created / cancelled / adjusted (dues change, no money moved) */
exports.chargeChanged = ({ libraryId, branchId = null } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId);
  if (!io) return;
  io.to(libraryTargets(libraryId, branchId).fees)
    .emit('dashboard:invalidate', { scope: 'library', widgets: ['kpis'], at: at() });
});

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------
exports.seatChanged = ({ libraryId, branchId = null, seatId = null, status = 'released' } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId);
  toLibrary(libraryId, branchId, 'seat:changed', { seatId: seatId ? String(seatId) : null, status });
  toLibrary(libraryId, branchId, 'kpi:update', { key: 'occupiedSeats', value: null, delta: null });
  invalidateLibrary(libraryId, branchId, ['seatLayout', 'kpis']);
});

// ---------------------------------------------------------------------------
// Notices / notifications
// ---------------------------------------------------------------------------
exports.noticeCreated = ({ libraryId, branchId = null, noticeId = null } = {}) => quiet(() => {
  if (!libraryId) return;
  summary().invalidateLibrary(libraryId);
  toLibrary(libraryId, branchId, 'notification:new', { kind: 'notice', id: noticeId ? String(noticeId) : null });
  invalidateLibrary(libraryId, branchId, ['notices']);
});

exports.notificationNew = ({ userId, id = null } = {}) => quiet(() => {
  if (!io || !userId) return;
  io.to(rooms.user(userId)).emit('notification:new', { kind: 'notification', id: id ? String(id) : null });
});

// ---------------------------------------------------------------------------
// Platform (superadmin)
// ---------------------------------------------------------------------------
const PLATFORM_LIBRARY = ['kpis', 'registrationTrend', 'librariesByPlan', 'recentRegistrations', 'subscriptionStatus', 'pendingApprovals', 'alerts'];

exports.libraryRegistered = ({ libraryId = null } = {}) => quiet(() => {
  summary().invalidatePlatform();
  toSuper('library:registered', { libraryId: libraryId ? String(libraryId) : null, status: 'pending' });
  toSuper('kpi:update', { key: 'totalLibraries', value: null, delta: 1 });
  invalidatePlatform(PLATFORM_LIBRARY);
});

/** status: approved | rejected | suspended | reinstated | deleted */
exports.libraryStatusChanged = ({ libraryId = null, status = 'changed' } = {}) => quiet(() => {
  summary().invalidatePlatform();
  if (libraryId) summary().invalidateLibrary(libraryId);
  toSuper('library:status', { libraryId: libraryId ? String(libraryId) : null, status });
  invalidatePlatform(PLATFORM_LIBRARY);
});

/** state: paid | lapsed | changed */
exports.subscriptionChanged = ({ libraryId = null, state = 'changed' } = {}) => quiet(() => {
  summary().invalidatePlatform();
  if (!io) return;
  const data = { libraryId: libraryId ? String(libraryId) : null, state };
  toSuper('subscription:changed', data);
  if (libraryId) io.to(rooms.lib(libraryId)).emit('subscription:changed', data);
  invalidatePlatform(['kpis', 'subscriptionStatus', 'revenueOverview', 'paymentActivity', 'alerts', 'librariesByPlan']);
});

exports.maintenanceChanged = () => quiet(() => {
  if (!io) return;
  io.emit('maintenance:changed', { refresh: true });
});

exports.setIo = setIo;
exports.isEnabled = isEnabled;

/**
 * Wrap an async service function: run it unchanged, and after it succeeds call onDone(args, result) without
 * waiting and without letting it throw. Errors from `fn` pass through untouched.
 */
exports.after = (fn, onDone) => async function afterWrapper(...args) {
  const result = await fn.apply(this, args);
  quiet(() => onDone(args, result));
  return result;
};
