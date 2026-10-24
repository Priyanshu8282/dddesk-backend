const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const Attendance = require('../models/attendance.model');
const AttendanceQR = require('../models/attendanceQR.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Seat = require('../models/seat.model');
const Library = require('../models/library.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const { startOfDayIST, endOfDayIST, IST_OFFSET_MS, DAY_MS } = require('../utils/time');

const MIN = 60 * 1000;
const STALE_SESSION_MS = 16 * 60 * MIN;
const QR_WINDOW_SEC = 60;

const DEFAULT_RULES = { graceMinutes: 15, lateAfterMinutes: 30, autoReleaseNoShow: false, noShowGraceMinutes: 60, enforceShift: false };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
const idOf = (v) => (v && v._id ? v._id : v);
const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc) || {};

// ─── Library settings (read defensively) ─────────────────────────────────────
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

const getRules = (library) => {
    const r = plain(library).attendanceRules || {};
    return {
        graceMinutes: num(r.graceMinutes, DEFAULT_RULES.graceMinutes),
        lateAfterMinutes: num(r.lateAfterMinutes, DEFAULT_RULES.lateAfterMinutes),
        autoReleaseNoShow: typeof r.autoReleaseNoShow === 'boolean' ? r.autoReleaseNoShow : DEFAULT_RULES.autoReleaseNoShow,
        noShowGraceMinutes: num(r.noShowGraceMinutes, DEFAULT_RULES.noShowGraceMinutes),
        enforceShift: r.enforceShift === true,
        allowSelfCheckWithoutQR: r.allowSelfCheckWithoutQR === true
    };
};

// "06:00 AM" | "6 pm" | "18:30" -> minutes since midnight
const parseClock = (str, fallback) => {
    if (typeof str !== 'string') return fallback;
    const m = str.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
    if (!m) return fallback;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] && m[3].toLowerCase();
    if (min > 59 || h > 24) return fallback;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
};

const getHours = (library) => {
    const wh = plain(library).workingHours || {};
    const open = parseClock(wh.openingTime, 6 * 60);
    let close = parseClock(wh.closingTime, 23 * 60);
    if (close <= open) close += 24 * 60; // closes after midnight
    // Holidays: legacy workingHours.weeklyHoliday (single name or list) + library.weeklyHolidays[]
    // (day names such as "Sunday"/"Sun", or 0-6 with 0 = Sunday).
    const holidays = new Set();
    const addDay = (raw) => {
        for (const part of String(raw == null ? '' : raw).split(/[,&/]|and/i)) {
            const t = part.trim().toLowerCase();
            if (!t || t === 'none') continue;
            if (/^[0-6]$/.test(t)) { holidays.add(WEEKDAYS[Number(t)]); continue; }
            const hit = t.length >= 3 ? WEEKDAYS.find((d) => d.startsWith(t.slice(0, 3))) : null;
            if (hit) holidays.add(hit);
        }
    };
    addDay(wh.weeklyHoliday);
    const lib = plain(library);
    (Array.isArray(lib.weeklyHolidays) ? lib.weeklyHolidays : []).forEach(addDay);
    return { open, close, weeklyHoliday: String(wh.weeklyHoliday || 'None').trim().toLowerCase(), holidays };
};

const attendanceAlertsOn = (library) => plain(library).notificationPrefs?.attendanceAlerts === true;

const loadLibrary = async (libraryId) => {
    const lib = await Library.findOne({ _id: libraryId, isDeleted: { $ne: true } }).lean();
    if (!lib) throw new ApiError(404, 'Library not found');
    return lib;
};

const weekdayName = (dayStart) => WEEKDAYS[new Date(new Date(dayStart).getTime() + IST_OFFSET_MS).getUTCDay()];
const isHoliday = (dayStart, hours) => hours.holidays instanceof Set
    ? hours.holidays.has(weekdayName(dayStart))
    : hours.weeklyHoliday !== 'none' && hours.weeklyHoliday === weekdayName(dayStart);
const dayKey = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const diffMinutes = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / MIN));

// Late / early flags relative to library hours + rules
const computeFlags = ({ checkIn, checkOut, rules, hours, checkLate = true }) => {
    const out = { isLate: false, lateByMinutes: 0, isEarlyExit: false, earlyByMinutes: 0 };
    if (checkIn && checkLate) {
        const dayStart = startOfDayIST(checkIn);
        const inMin = (new Date(checkIn) - dayStart) / MIN;
        const lateBy = Math.round(inMin - (hours.open + rules.lateAfterMinutes));
        if (lateBy > 0) { out.isLate = true; out.lateByMinutes = lateBy; }
    }
    if (checkIn && checkOut) {
        const dayStart = startOfDayIST(checkIn);
        const outMin = (new Date(checkOut) - dayStart) / MIN;
        const earlyBy = Math.round((hours.close - rules.graceMinutes) - outMin);
        if (earlyBy > 0) { out.isEarlyExit = true; out.earlyByMinutes = earlyBy; }
    }
    return out;
};

// ─── Eligibility ─────────────────────────────────────────────────────────────
const getStudentInLibrary = async (studentId, libraryId) => {
    if (!isValidId(studentId)) throw new ApiError(400, 'Invalid student ID');
    const student = await Student.findOne({ _id: studentId, libraryId });
    if (!student) throw new ApiError(404, 'Student not found');
    return student;
};

// Throws when the student cannot use the library. Returns non-blocking warnings.
const assertEligible = (student, libraryId, library, { strictMembership = true } = {}) => {
    if (String(idOf(student.libraryId)) !== String(libraryId)) {
        throw new ApiError(403, 'You do not belong to this library');
    }
    if (student.isDeleted || student.status !== 'active') {
        throw new ApiError(403, 'Your account is not active. Please contact the library.');
    }
    const warnings = [];
    const expired = student.expiryDate && new Date(student.expiryDate) < new Date();
    if (strictMembership) {
        if (student.planStatus !== 'active') throw new ApiError(403, 'No active membership. Please renew your plan.');
        if (expired) throw new ApiError(403, 'Membership expired. Please renew.');
    } else if (student.planStatus !== 'active' || expired) {
        warnings.push('Student membership is not active or has expired');
    }
    const policy = plain(library).feePolicy || {};
    if (policy.blockAfterDue && student.paymentStatus === 'pending') {
        warnings.push('Fees are due');
    }
    return warnings;
};

// ─── Sessions ────────────────────────────────────────────────────────────────
const findOpenSession = (studentId, libraryId) =>
    Attendance.findOne({ studentId, libraryId, status: 'present', checkOut: { $exists: false } });

const isStale = (session, now = new Date()) =>
    new Date(session.date) < startOfDayIST(now) || now - new Date(session.checkIn) > STALE_SESSION_MS;

const closeStaleSession = async (session, hours, rules) => {
    const checkIn = new Date(session.checkIn);
    const closeAt = startOfDayIST(checkIn).getTime() + hours.close * MIN;
    let out = new Date(Math.min(closeAt, checkIn.getTime() + STALE_SESSION_MS, Date.now()));
    if (out < checkIn) out = checkIn;
    const flags = computeFlags({ checkIn, checkOut: out, rules, hours, checkLate: false });
    return Attendance.findOneAndUpdate(
        { _id: session._id, checkOut: { $exists: false } },
        {
            $set: {
                checkOut: out, duration: diffMinutes(checkIn, out), autoClosed: true,
                manualCloseReason: 'Auto-closed: check-out missing',
                isEarlyExit: flags.isEarlyExit, earlyByMinutes: flags.earlyByMinutes
            },
            $unset: { open: 1 }
        },
        { new: true }
    );
};

// Cron hook: closes open sessions older than 16h or from a previous IST day.
// Optionally limited to a library / student. Returns the number closed.
const autoCloseStaleSessions = async ({ libraryId, studentId } = {}) => {
    const now = new Date();
    const filter = {
        status: 'present',
        checkOut: { $exists: false },
        $or: [{ date: { $lt: startOfDayIST(now) } }, { checkIn: { $lt: new Date(now - STALE_SESSION_MS) } }]
    };
    if (libraryId) filter.libraryId = libraryId;
    if (studentId) filter.studentId = studentId;

    const cache = new Map();
    let closed = 0;
    const cursor = Attendance.find(filter).cursor();
    for await (const session of cursor) {
        const key = String(session.libraryId);
        if (!cache.has(key)) {
            const lib = await Library.findById(session.libraryId).lean();
            cache.set(key, { hours: getHours(lib), rules: getRules(lib) });
        }
        const { hours, rules } = cache.get(key);
        const res = await closeStaleSession(session, hours, rules);
        if (res) closed += 1;
    }
    return closed;
};

// "HH:mm" | "6:30 AM" -> minutes since midnight, or null
const shiftMinutes = (v) => { const m = parseClock(v, null); return m === null || m === undefined ? null : m % (24 * 60); };

// IST minute-of-day of an instant
const istMinuteOfDay = (d) => Math.floor(((new Date(d).getTime() + IST_OFFSET_MS) % DAY_MS) / MIN);

// Is minute-of-day `m` inside [start-grace, end+grace] (window may wrap past midnight)?
const withinShift = (m, start, end, grace) => {
    const day = 24 * 60;
    const lo = start - grace;
    let hi = end + grace;
    if (end <= start) hi += day; // overnight shift
    for (const x of [m, m + day, m - day]) if (x >= lo && x <= hi) return true;
    return false;
};

// Plan shift window of the student's active plan (null when the plan has none)
const getShiftWindow = async (student) => {
    if (!student.planId) return null;
    const plan = await Plan.findOne({ _id: idOf(student.planId), libraryId: idOf(student.libraryId) })
        .select('shiftName shiftStart shiftEnd').lean();
    if (!plan) return null;
    const start = shiftMinutes(plan.shiftStart);
    const end = shiftMinutes(plan.shiftEnd);
    if (start === null || end === null) return null;
    return { start, end, name: plan.shiftName || '', label: `${plan.shiftStart} - ${plan.shiftEnd}` };
};

// Attendance belongs to the student's branch, or else the branch of the student's seat
const resolveBranchId = async (student) => {
    if (student.branchId) return idOf(student.branchId);
    const seatId = student.seatId || null;
    const seat = seatId
        ? await Seat.findOne({ _id: idOf(seatId) }).select('branchId').lean()
        : (student.seatNumber ? await Seat.findOne({ libraryId: idOf(student.libraryId), seatNumber: student.seatNumber }).select('branchId').lean() : null);
    return (seat && seat.branchId) || null;
};

const duplicateKey = (e) => e && (e.code === 11000 || /E11000/.test(e.message || ''));

const checkIn = async ({ student, library, source = 'manual', at = new Date(), markedBy }) => {
    const libraryId = idOf(student.libraryId);
    await autoCloseStaleSessions({ libraryId, studentId: student._id });
    const existing = await findOpenSession(student._id, libraryId);
    if (existing) throw new ApiError(409, 'Already checked in. Please check out first.');

    const rules = getRules(library);
    const hours = getHours(library);
    const date = startOfDayIST(at);
    const firstToday = !(await Attendance.exists({ studentId: student._id, libraryId, date, status: 'present' }));
    const flags = computeFlags({ checkIn: at, rules, hours, checkLate: firstToday });

    // Plan shift window: reject (enforceShift + not a staff-entered check-in) or just flag
    let outsideShift = false;
    const shift = await getShiftWindow(student);
    if (shift && !withinShift(istMinuteOfDay(at), shift.start, shift.end, rules.graceMinutes)) {
        outsideShift = true;
        if (rules.enforceShift && source !== 'manual') {
            throw new ApiError(403, `Check-in is allowed only during your plan's shift (${shift.label}, ${rules.graceMinutes} min grace). Please come during your shift.`);
        }
    }
    const branchId = await resolveBranchId(student);
    try {
        return await Attendance.create({
            studentId: student._id, libraryId, branchId, date, checkIn: at, status: 'present',
            source, open: true, markedBy, outsideShift, ...flags
        });
    } catch (e) {
        if (duplicateKey(e)) throw new ApiError(409, 'Already checked in. Please check out first.');
        throw e;
    }
};

const checkOut = async ({ student, library, at = new Date(), manual = null }) => {
    const libraryId = idOf(student.libraryId);
    const session = await findOpenSession(student._id, libraryId);
    if (!session) throw new ApiError(409, 'No open check-in found. Please check in first.');
    if (isStale(session, at)) {
        await closeStaleSession(session, getHours(library), getRules(library));
        throw new ApiError(409, 'Your previous session was auto-closed. Please check in again.');
    }
    if (new Date(at) <= new Date(session.checkIn)) throw new ApiError(400, 'Check-out time must be after check-in');

    const flags = computeFlags({ checkIn: session.checkIn, checkOut: at, rules: getRules(library), hours: getHours(library), checkLate: false });
    const set = { checkOut: at, duration: diffMinutes(session.checkIn, at), isEarlyExit: flags.isEarlyExit, earlyByMinutes: flags.earlyByMinutes };
    if (manual) Object.assign(set, manual);
    const updated = await Attendance.findOneAndUpdate(
        { _id: session._id, checkOut: { $exists: false } },
        { $set: set, $unset: { open: 1 } },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Session already closed');
    return updated;
};

// ─── QR ──────────────────────────────────────────────────────────────────────
// Separate secret derived from the JWT secret so login tokens can never be QR tokens (and vice versa)
const qrSecret = () => crypto.createHmac('sha256', config.jwt.secret).update('qr').digest('hex');
const QR_PREFIX = 'DDDESK-ATT:';

const generateQR = async (libraryId) => {
    const lib = String(libraryId);
    const nowSec = Math.floor(Date.now() / 1000);
    const win = Math.floor(nowSec / QR_WINDOW_SEC);
    const nonce = `${lib}:${win}`;
    const exp = (win + 2) * QR_WINDOW_SEC; // current window + one grace window
    const token = jwt.sign({ type: 'attendance_qr', lib, win, jti: nonce, exp }, qrSecret(), { algorithm: 'HS256', noTimestamp: true });
    try {
        await AttendanceQR.updateOne(
            { nonce },
            { $setOnInsert: { libraryId, window: win, expiresAt: new Date((exp + 3600) * 1000) } },
            { upsert: true }
        );
    } catch (e) { if (!duplicateKey(e)) throw e; }
    return {
        token,
        qrText: `${QR_PREFIX}${token}`,
        rotatesInSeconds: (win + 1) * QR_WINDOW_SEC - nowSec,
        windowSeconds: QR_WINDOW_SEC,
        expiresAt: new Date(exp * 1000),
        nextRefreshAt: new Date((win + 1) * QR_WINDOW_SEC * 1000)
    };
};

const verifyQR = (rawToken, libraryId) => {
    let token = String(rawToken || '').trim();
    if (token.startsWith(QR_PREFIX)) token = token.slice(QR_PREFIX.length);
    let decoded;
    try {
        decoded = jwt.verify(token, qrSecret(), { algorithms: ['HS256'] });
    } catch (e) {
        throw new ApiError(400, 'Invalid or expired QR code. Please scan the current QR.');
    }
    if (decoded.type !== 'attendance_qr' || !decoded.jti) throw new ApiError(400, 'Invalid QR code.');
    if (decoded.lib !== String(libraryId)) throw new ApiError(403, 'This QR code belongs to a different library.');
    return decoded;
};

// Claim the code for this student. Returns false when the student already used this code.
const claimQR = async (payload, libraryId, studentId, direction) => {
    try {
        await AttendanceQR.updateOne(
            { nonce: payload.jti },
            { $setOnInsert: { libraryId, window: payload.win, expiresAt: new Date((payload.exp + 3600) * 1000) } },
            { upsert: true }
        );
    } catch (e) { if (!duplicateKey(e)) throw e; }
    const res = await AttendanceQR.updateOne(
        { nonce: payload.jti, 'scans.studentId': { $ne: studentId } },
        { $push: { scans: { studentId, direction, at: new Date() } } }
    );
    return res.modifiedCount === 1;
};

const releaseQR = (payload, studentId) =>
    AttendanceQR.updateOne({ nonce: payload.jti }, { $pull: { scans: { studentId } } }).catch(() => {});

const notifyAttendance = (student, library, kind, session) => {
    if (!attendanceAlertsOn(library)) return;
    try {
        const { notifyStudent } = require('./firebase.service');
        const title = kind === 'in' ? 'Checked in' : 'Checked out';
        const body = kind === 'in'
            ? 'Your check-in has been recorded.'
            : `Your check-out has been recorded. Time spent: ${session.duration} min.`;
        notifyStudent(student._id, title, body, { attendanceId: String(session._id) }, 'attendance_alert').catch(() => {});
    } catch (_) { /* notifications are best effort */ }
};

/**
 * Student-driven check-in/out via QR (or without QR when the library allows it).
 * action: 'in' | 'out' | undefined (auto-toggle).
 */
const studentScan = async ({ student, library, token, action, source = 'qr' }) => {
    const libraryId = idOf(student.libraryId);
    const settings = plain(library).settings || {};
    if (settings.attendanceEnabled === false) throw new ApiError(403, 'Attendance is disabled for this library');

    const rules = getRules(library);
    let payload = null;
    if (token) payload = verifyQR(token, libraryId);
    else if (!rules.allowSelfCheckWithoutQR) throw new ApiError(400, 'Please scan the library QR code to continue');

    // Inactive students are rejected before the code is claimed
    const warnings = assertEligible(student, libraryId, library, { strictMembership: true });

    const open = await findOpenSession(student._id, libraryId);
    const direction = open ? 'out' : 'in';
    if (action && action !== direction) {
        throw new ApiError(409, direction === 'out' ? 'You are already checked in' : 'You are not checked in');
    }

    if (payload) {
        const claimed = await claimQR(payload, libraryId, student._id, direction);
        if (!claimed) throw new ApiError(409, 'You already used this QR code. Please scan the next one.');
    }
    try {
        const session = direction === 'in'
            ? await checkIn({ student, library, source: payload ? source : 'self' })
            : await checkOut({ student, library });
        notifyAttendance(student, library, direction, session);
        return { action: direction === 'in' ? 'check-in' : 'check-out', attendance: session, warnings };
    } catch (e) {
        if (payload) await releaseQR(payload, student._id);
        throw e;
    }
};

// Staff manual check-in/out
const manualMark = async ({ libraryId, library, studentId, type, time, markedBy }) => {
    const student = await getStudentInLibrary(studentId, libraryId);
    if (student.status !== 'active') throw new ApiError(400, 'Student account is not active');
    const warnings = assertEligible(student, libraryId, library, { strictMembership: false });
    const at = time ? new Date(time) : new Date();
    if (Number.isNaN(at.getTime())) throw new ApiError(400, 'Invalid time');
    if (at.getTime() > Date.now() + 5 * MIN) throw new ApiError(400, 'Time cannot be in the future');
    const session = type === 'in'
        ? await checkIn({ student, library, source: 'manual', at, markedBy })
        : await checkOut({ student, library, at, manual: { markedBy } });
    notifyAttendance(student, library, type, session);
    return { action: type === 'in' ? 'check-in' : 'check-out', attendance: session, warnings };
};

const manualClose = async ({ id, libraryId, library, reason, checkOutTime, userId }) => {
    if (!isValidId(id)) throw new ApiError(400, 'Invalid attendance ID');
    const att = await Attendance.findOne({ _id: id, libraryId, status: 'present', checkOut: { $exists: false } });
    if (!att) throw new ApiError(404, 'No open session found with this ID.');

    let out = new Date();
    if (checkOutTime) {
        out = new Date(checkOutTime);
        if (Number.isNaN(out.getTime())) throw new ApiError(400, 'Invalid check-out time');
        if (out > new Date(Date.now() + 5 * MIN)) throw new ApiError(400, 'Check-out time cannot be in the future');
        if (out <= att.checkIn) throw new ApiError(400, 'Check-out time must be after check-in');
    }
    const flags = computeFlags({ checkIn: att.checkIn, checkOut: out, rules: getRules(library), hours: getHours(library), checkLate: false });
    const updated = await Attendance.findOneAndUpdate(
        { _id: att._id, checkOut: { $exists: false } },
        {
            $set: {
                checkOut: out, duration: diffMinutes(att.checkIn, out), manualClose: true,
                manualCloseReason: reason || 'Closed by admin', manualClosedBy: userId,
                isEarlyExit: flags.isEarlyExit, earlyByMinutes: flags.earlyByMinutes
            },
            $unset: { open: 1 }
        },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Session already closed');
    return updated;
};

const correctSession = async ({ id, libraryId, library, body, userId }) => {
    if (!isValidId(id)) throw new ApiError(400, 'Invalid attendance ID');
    const att = await Attendance.findOne({ _id: id, libraryId });
    if (!att) throw new ApiError(404, 'Attendance record not found');

    const snap = (a) => ({
        status: a.status, checkIn: a.checkIn || null, checkOut: a.checkOut || null,
        duration: a.duration, leaveReason: a.leaveReason || null
    });
    const before = snap(att);

    const limit = Date.now() + 5 * MIN;
    if (body.status) att.status = body.status;
    if (body.checkIn !== undefined) att.checkIn = body.checkIn === null ? undefined : new Date(body.checkIn);
    if (body.checkOut !== undefined) att.checkOut = body.checkOut === null ? undefined : new Date(body.checkOut);

    if (att.status === 'present') {
        if (!att.checkIn) throw new ApiError(400, 'checkIn is required for a present record');
        if (att.checkIn.getTime() > limit || (att.checkOut && att.checkOut.getTime() > limit)) {
            throw new ApiError(400, 'Times cannot be in the future');
        }
        if (att.checkOut && att.checkOut <= att.checkIn) throw new ApiError(400, 'checkOut must be after checkIn');
        att.date = startOfDayIST(att.checkIn);
        att.duration = att.checkOut ? diffMinutes(att.checkIn, att.checkOut) : 0;
        att.open = att.checkOut ? undefined : true;
        const flags = computeFlags({ checkIn: att.checkIn, checkOut: att.checkOut, rules: getRules(library), hours: getHours(library) });
        Object.assign(att, flags);
    } else {
        att.checkIn = undefined; att.checkOut = undefined; att.duration = 0; att.open = undefined;
        att.isLate = false; att.lateByMinutes = 0; att.isEarlyExit = false; att.earlyByMinutes = 0;
        if (att.status === 'leave' && body.leaveReason) att.leaveReason = body.leaveReason;
    }
    att.corrections.push({ by: userId, at: new Date(), reason: body.reason, before, after: snap(att) });
    try {
        await att.save();
    } catch (e) {
        if (duplicateKey(e)) throw new ApiError(409, 'Student already has another open session');
        throw e;
    }
    return att;
};

const markLeave = async ({ libraryId, studentId, date, reason, userId }) => {
    const student = await getStudentInLibrary(studentId, libraryId);
    const day = startOfDayIST(new Date(date));
    if (Number.isNaN(day.getTime())) throw new ApiError(400, 'Invalid date');
    if (await Attendance.exists({ studentId: student._id, libraryId, date: day, status: 'present' })) {
        throw new ApiError(409, 'Student is already marked present on this date');
    }
    const branchId = await resolveBranchId(student);
    return Attendance.findOneAndUpdate(
        { studentId: student._id, libraryId, date: day, status: { $in: ['leave', 'absent'] } },
        { $set: { status: 'leave', leaveReason: reason, markedBy: userId, source: 'manual', duration: 0, branchId } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

// Cron helper: creates 'absent' records for active students with no record on `date` (default today).
// Skips the library's weekly holiday. Returns number of absent records created.
const markAbsentees = async ({ date = new Date(), libraryId } = {}) => {
    const day = startOfDayIST(date);
    const libFilter = { status: 'active', isDeleted: { $ne: true } };
    if (libraryId) libFilter._id = libraryId;
    const libraries = await Library.find(libFilter).lean();
    let created = 0;
    for (const lib of libraries) {
        const hours = getHours(lib);
        if (isHoliday(day, hours)) continue;
        if (plain(lib).settings?.attendanceEnabled === false) continue;
        const students = await Student.find({
            libraryId: lib._id, status: 'active', planStatus: 'active',
            joiningDate: { $lte: endOfDayIST(day) },
            $or: [{ expiryDate: { $exists: false } }, { expiryDate: null }, { expiryDate: { $gte: day } }]
        }).select('_id branchId').lean();
        if (!students.length) continue;
        const have = new Set((await Attendance.distinct('studentId', { libraryId: lib._id, date: day })).map(String));
        const docs = students.filter((s) => !have.has(String(s._id)))
            .map((s) => ({ studentId: s._id, libraryId: lib._id, branchId: s.branchId || null, date: day, status: 'absent', source: 'system' }));
        if (docs.length) {
            await Attendance.insertMany(docs, { ordered: false });
            created += docs.length;
        }
    }
    return created;
};

// ─── Queries ─────────────────────────────────────────────────────────────────
const STUDENT_FIELDS = 'name mobile rollNumber profileImage seatNumber';

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
const getToday = async (libraryId, query = {}, scope = {}) => {
    await autoCloseStaleSessions({ libraryId });
    const today = startOfDayIST(new Date());
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const search = query.search ? String(query.search).trim().toLowerCase() : '';
    const statusFilter = query.status ? String(query.status).toUpperCase() : 'ALL';

    const students = await Student.find({ libraryId, status: 'active', ...scope }).select(STUDENT_FIELDS).lean();
    const records = await Attendance.find({ libraryId, date: today, studentId: { $in: students.map((s) => s._id) } }).sort({ checkIn: 1 }).lean();

    const byStudent = new Map();
    for (const r of records) {
        const k = String(r.studentId);
        if (!byStudent.has(k)) byStudent.set(k, []);
        byStudent.get(k).push(r);
    }

    const counts = { present: 0, inside: 0, absent: 0, leave: 0 };
    let rows = students.map((s) => {
        const list = byStudent.get(String(s._id)) || [];
        const sessions = list.filter((r) => r.status === 'present');
        const base = {
            studentId: String(s._id), name: s.name, mobile: s.mobile || '', rollNumber: s.rollNumber || '',
            profileImage: s.profileImage || null, seatNumber: s.seatNumber || null, date: today
        };
        if (sessions.length) {
            const last = sessions[sessions.length - 1];
            const inside = !last.checkOut;
            counts[inside ? 'inside' : 'present'] += 1;
            return {
                ...base, _id: String(last._id), status: inside ? 'INSIDE' : 'PRESENT',
                checkIn: sessions[0].checkIn, checkOut: last.checkOut || null,
                duration: sessions.reduce((t, r) => t + (r.duration || 0), 0), sessions: sessions.length,
                isLate: !!sessions[0].isLate, lateByMinutes: sessions[0].lateByMinutes || 0, isEarlyExit: !!last.isEarlyExit
            };
        }
        const leave = list.find((r) => r.status === 'leave');
        if (leave) {
            counts.leave += 1;
            return { ...base, _id: String(leave._id), status: 'LEAVE', checkIn: null, checkOut: null, duration: null, leaveReason: leave.leaveReason || null };
        }
        counts.absent += 1;
        return { ...base, _id: `absent-${s._id}`, status: 'ABSENT', checkIn: null, checkOut: null, duration: null };
    });

    if (statusFilter !== 'ALL') rows = rows.filter((r) => r.status === statusFilter);
    if (search) {
        rows = rows.filter((r) => r.name.toLowerCase().includes(search) || r.mobile.includes(search) || r.rollNumber.toLowerCase().includes(search));
    }
    const total = rows.length;
    return {
        results: rows.slice((page - 1) * limit, page * limit),
        summary: { total: students.length, ...counts },
        total, totalPages: Math.ceil(total / limit), page
    };
};

const getActive = async (libraryId, scope = {}) => {
    await autoCloseStaleSessions({ libraryId });
    const active = await Attendance.find({ libraryId, ...scope, status: 'present', checkOut: { $exists: false } })
        .populate('studentId', STUDENT_FIELDS).sort({ checkIn: -1 }).lean();
    const results = active.map((att) => ({
        _id: att._id, studentId: att.studentId?._id, name: att.studentId?.name || 'Unknown',
        mobile: att.studentId?.mobile || '', rollNumber: att.studentId?.rollNumber || '',
        profileImage: att.studentId?.profileImage || null, seatNumber: att.studentId?.seatNumber || null,
        checkIn: att.checkIn, isLate: att.isLate,
        minutesInside: Math.round((Date.now() - new Date(att.checkIn).getTime()) / MIN)
    }));
    return { results, count: results.length };
};

const buildRange = ({ date, startDate, endDate }) => {
    if (date) return { $gte: startOfDayIST(new Date(date)), $lte: endOfDayIST(new Date(date)) };
    const r = {};
    if (startDate) r.$gte = startOfDayIST(new Date(startDate));
    if (endDate) r.$lte = endOfDayIST(new Date(endDate));
    return Object.keys(r).length ? r : null;
};

const queryAttendance = async (libraryId, query = {}, scope = {}) => {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 200);
    const filter = { libraryId, ...scope };
    const range = buildRange(query);
    if (range) filter.date = range;
    if (query.status) filter.status = query.status;
    if (query.studentId) {
        if (!isValidId(query.studentId)) throw new ApiError(400, 'Invalid student ID');
        filter.studentId = query.studentId;
    }
    if (query.search) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        const ids = await Student.find({ libraryId, $or: [{ name: rx }, { mobile: rx }, { rollNumber: rx }] }).select('_id').limit(500).lean();
        filter.studentId = { $in: ids.map((s) => s._id) };
    }
    const [results, totalResults] = await Promise.all([
        Attendance.find(filter).populate('studentId', 'name mobile rollNumber').sort({ date: -1, checkIn: -1 })
            .skip((page - 1) * limit).limit(limit).lean(),
        Attendance.countDocuments(filter)
    ]);
    return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

// ─── Percentage / summary ────────────────────────────────────────────────────
const countWorkingDays = (from, to, hours) => {
    let n = 0;
    for (let t = startOfDayIST(from).getTime(); t <= to.getTime(); t += DAY_MS) {
        if (!isHoliday(new Date(t), hours)) n += 1;
    }
    return n;
};

const resolveRange = (query = {}) => {
    const today = startOfDayIST(new Date());
    let from; let to;
    if (query.month) {
        const [y, m] = String(query.month).split('-').map(Number);
        from = startOfDayIST(new Date(Date.UTC(y, m - 1, 1, 6)));
        to = endOfDayIST(new Date(Date.UTC(y, m, 0, 6)));
    } else {
        const toRaw = query.to || query.endDate;
        const fromRaw = query.from || query.startDate;
        to = toRaw ? endOfDayIST(new Date(toRaw)) : endOfDayIST(new Date());
        from = fromRaw ? startOfDayIST(new Date(fromRaw)) : new Date(startOfDayIST(to).getTime() - 29 * DAY_MS);
    }
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new ApiError(400, 'Invalid date range');
    if (to < from) throw new ApiError(400, 'End date must not be before start date');
    if (to - from > 366 * DAY_MS) throw new ApiError(400, 'Range cannot exceed one year');
    if (to > endOfDayIST(today)) to = endOfDayIST(today); // no future days
    return { from, to };
};

const studentSummary = async ({ student, library, query }) => {
    const hours = getHours(library);
    const { from, to } = resolveRange(query);
    const effFrom = student.joiningDate && startOfDayIST(student.joiningDate) > from ? startOfDayIST(student.joiningDate) : from;
    const libraryId = idOf(student.libraryId);
    const records = await Attendance.find({
        studentId: student._id, libraryId, date: { $gte: from, $lte: to }, status: { $in: ['present', 'leave'] }
    }).select('date status duration isLate').lean();

    const present = new Set(); const leave = new Set(); let minutes = 0; let lateDays = 0;
    for (const r of records) {
        const k = dayKey(r.date);
        if (r.status === 'present') {
            if (!present.has(k) && r.isLate) lateDays += 1;
            present.add(k); minutes += r.duration || 0;
        } else leave.add(k);
    }
    for (const k of present) leave.delete(k);
    const workingDays = effFrom <= to ? countWorkingDays(effFrom, to, hours) : 0;
    const effective = Math.max(workingDays - leave.size, 0);
    const presentDays = present.size;
    const percentage = effective > 0 ? Math.min(100, Math.round((presentDays / effective) * 1000) / 10) : 0;
    return {
        studentId: student._id, from, to, workingDays, presentDays, leaveDays: leave.size,
        absentDays: Math.max(effective - presentDays, 0), lateDays, totalMinutes: minutes, percentage
    };
};

const percentageReport = async ({ libraryId, library, query, scope = {} }) => {
    const hours = getHours(library);
    const { from, to } = resolveRange(query);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);

    const studentFilter = { libraryId, status: 'active', ...scope };
    const total = await Student.countDocuments(studentFilter);
    const students = await Student.find(studentFilter).select('name mobile rollNumber joiningDate')
        .sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean();
    const ids = students.map((s) => s._id);

    const agg = await Attendance.aggregate([
        { $match: { libraryId: new mongoose.Types.ObjectId(String(libraryId)), studentId: { $in: ids }, date: { $gte: from, $lte: to }, status: { $in: ['present', 'leave'] } } },
        { $group: { _id: { s: '$studentId', d: '$date', st: '$status' }, minutes: { $sum: '$duration' } } },
        { $group: {
            _id: '$_id.s',
            present: { $sum: { $cond: [{ $eq: ['$_id.st', 'present'] }, 1, 0] } },
            leave: { $sum: { $cond: [{ $eq: ['$_id.st', 'leave'] }, 1, 0] } },
            minutes: { $sum: '$minutes' }
        } }
    ]);
    const map = new Map(agg.map((a) => [String(a._id), a]));
    const results = students.map((s) => {
        const a = map.get(String(s._id)) || { present: 0, leave: 0, minutes: 0 };
        const effFrom = s.joiningDate && startOfDayIST(s.joiningDate) > from ? startOfDayIST(s.joiningDate) : from;
        const workingDays = effFrom <= to ? countWorkingDays(effFrom, to, hours) : 0;
        const effective = Math.max(workingDays - a.leave, 0);
        return {
            studentId: s._id, name: s.name, mobile: s.mobile, rollNumber: s.rollNumber,
            workingDays, presentDays: a.present, leaveDays: a.leave, totalMinutes: a.minutes,
            percentage: effective > 0 ? Math.min(100, Math.round((a.present / effective) * 1000) / 10) : 0
        };
    });
    return { from, to, results, page, limit, totalResults: total, totalPages: Math.ceil(total / limit) };
};

// Daily head-count for the chart: how many different students were present / on leave each day (IST days, newest last)
const trend = async ({ libraryId, days = 14, scope = {} }) => {
    const n = Math.min(Math.max(parseInt(days, 10) || 14, 3), 90);
    const to = startOfDayIST(new Date());
    const from = new Date(to.getTime() - (n - 1) * DAY_MS);
    const rows = await Attendance.aggregate([
        { $match: { libraryId: new mongoose.Types.ObjectId(String(libraryId)), date: { $gte: from, $lte: endOfDayIST(to) }, status: { $in: ['present', 'leave'] }, ...scope } },
        { $group: { _id: { d: '$date', s: '$studentId', st: '$status' }, minutes: { $sum: '$duration' } } },
        { $group: { _id: { d: '$_id.d', st: '$_id.st' }, students: { $sum: 1 }, minutes: { $sum: '$minutes' } } }
    ]);
    const fmt = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const map = new Map();
    rows.forEach((r) => {
        const k = fmt(new Date(r._id.d));
        const cur = map.get(k) || { present: 0, leave: 0, minutes: 0 };
        if (r._id.st === 'present') { cur.present = r.students; cur.minutes = r.minutes; } else cur.leave = r.students;
        map.set(k, cur);
    });
    const activeStudents = await Student.countDocuments({ libraryId, status: 'active', ...scope });
    const results = [];
    for (let i = 0; i < n; i++) {
        const day = new Date(from.getTime() + i * DAY_MS);
        const k = fmt(day);
        const v = map.get(k) || { present: 0, leave: 0, minutes: 0 };
        results.push({ date: k, present: v.present, leave: v.leave, absent: Math.max(activeStudents - v.present - v.leave, 0), minutes: v.minutes });
    }
    return { days: n, activeStudents, results };
};

// CSV of the filtered history (up to 20,000 rows)
const csvCell = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+@\t\r-]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const exportCsv = async ({ libraryId, query = {}, scope = {}, write }) => {
    const filter = { libraryId, ...scope };
    const range = buildRange(query);
    if (range) filter.date = range;
    if (query.status) filter.status = query.status;
    if (query.studentId && isValidId(query.studentId)) filter.studentId = query.studentId;
    if (query.search) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        const ids = await Student.find({ libraryId, $or: [{ name: rx }, { mobile: rx }, { rollNumber: rx }] }).select('_id').limit(500).lean();
        filter.studentId = { $in: ids.map((s) => s._id) };
    }
    await write('\uFEFF' + ['Date', 'Student', 'Mobile', 'Roll no', 'Status', 'Check in', 'Check out', 'Minutes', 'Late', 'Source', 'Leave reason'].map(csvCell).join(',') + '\n');
    const cursor = Attendance.find(filter).populate('studentId', 'name mobile rollNumber').sort({ date: -1, checkIn: -1 }).limit(20000).lean().cursor();
    for await (const r of cursor) {
        const day = new Date(new Date(r.date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
        await write([day, r.studentId && r.studentId.name, r.studentId && r.studentId.mobile, r.studentId && r.studentId.rollNumber, r.status, r.checkIn, r.checkOut, r.duration, r.isLate ? 'yes' : '', r.source, r.leaveReason].map(csvCell).join(',') + '\n');
    }
};

const myHistory = async ({ student, library, query }) => {
    const libraryId = idOf(student.libraryId);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
    const filter = { studentId: student._id, libraryId };
    const range = buildRange(query);
    if (range) filter.date = range;
    const [results, totalResults, summary] = await Promise.all([
        Attendance.find(filter).select('-corrections -markedBy -manualClosedBy').sort({ date: -1, checkIn: -1 })
            .skip((page - 1) * limit).limit(limit).lean(),
        Attendance.countDocuments(filter),
        studentSummary({ student, library, query })
    ]);
    return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults, summary };
};

module.exports = {
    getRules, getHours, computeFlags, assertEligible, getStudentInLibrary, loadLibrary,
    checkIn, checkOut, autoCloseStaleSessions, markAbsentees,
    generateQR, verifyQR, studentScan, manualMark, manualClose, correctSession, markLeave,
    getToday, getActive, queryAttendance, trend, exportCsv, studentSummary, percentageReport, myHistory, isValidId
};

// ---- Live dashboards (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
const attendanceEvent = ([a]) => {
    const libraryId = (a && (a.libraryId || (a.library && a.library._id))) || null;
    if (libraryId) realtime.attendanceChanged({ libraryId, branchId: (a.student && a.student.branchId) || null });
};
for (const name of ['checkIn', 'checkOut', 'studentScan', 'manualMark', 'manualClose', 'correctSession', 'markLeave', 'markAbsentees', 'autoCloseStaleSessions']) {
    module.exports[name] = realtime.after(module.exports[name], attendanceEvent);
}
