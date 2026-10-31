const mongoose = require('mongoose');
const Seat = require('../models/seat.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Library = require('../models/library.model');
const Attendance = require('../models/attendance.model');
const SeatHistory = require('../models/seatHistory.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const SEAT_CREATE_FIELDS = ['seatNumber', 'floor', 'room', 'type', 'customType', 'price'];
const SEAT_UPDATE_FIELDS = ['seatNumber', 'floor', 'room', 'type', 'customType', 'price'];
const CLEAR_RESERVATION = { reservedFor: null, reservedUntil: null, reservedReason: null };

/** Fire-and-forget history entry; never breaks the main flow. */
const logSeat = async (libraryId, seat, action, { studentId = null, relatedSeatId = null, reason, actor } = {}) => {
    try {
        await SeatHistory.create({
            libraryId,
            seatId: seat._id,
            seatNumber: seat.seatNumber,
            branchId: seat.branchId || null,
            studentId,
            action,
            relatedSeatId,
            reason,
            performedBy: actor?.id || undefined,
            performedByType: actor?.type || 'system'
        });
    } catch (e) {
        console.error('Seat history log failed:', e.message);
    }
};

/** Fire-and-forget 'seat-update' notification to the student; never affects the seat action. */
const notifySeat = (libraryId, studentId, action, seatNumber) => {
    try {
        if (!studentId) return;
        Promise.resolve(require('./notification.service').notifyEvent('seat-update', libraryId, {
            studentId, variables: { action, seatSuffix: seatNumber ? ` (seat ${seatNumber})` : '' },
            data: { type: 'seat_update', action }
        })).catch(() => {});
    } catch (_) { /* ignore */ }
};

const actorOf = (req) => (req && req.user ? { id: req.user._id, type: req.userType } : null);

/** Does the plan allow this seat type? (empty seatTypes or 'all' = any) */
const isSeatTypeEligible = (plan, seat) => {
    const types = plan?.seatTypes || [];
    if (!types.length || types.includes('all')) return true;
    return types.includes(seat.type);
};

const duplicateSeatError = (e, num) => {
    if (e && e.code === 11000) return new ApiError(400, `Seat number "${num}" already exists in this library`);
    return e;
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const checkSeatLimit = async (libraryId, requestingCount = 1) => {
    const library = await Library.findById(libraryId).select('planLimits');
    if (!library) return;
    const maxSeats = library.planLimits?.maxSeats ?? 50;
    const currentCount = await Seat.countDocuments({ libraryId, isDeleted: false });
    if (currentCount + requestingCount > maxSeats) {
        throw new ApiError(403, `Seat limit reached (${maxSeats}). Upgrade your subscription plan to add more seats.`);
    }
    return maxSeats;
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
const normaliseCreateStatus = (status) => {
    // A seat can never be created 'occupied' (or 'reserved') without a student
    if (status === 'blocked' || status === 'maintenance') return status;
    return 'available';
};

const createSeat = async (libraryId, data, createdBy, branchId = null) => {
    await checkSeatLimit(libraryId, 1);
    const doc = { ...pick(data, SEAT_CREATE_FIELDS), status: normaliseCreateStatus(data.status), libraryId, createdBy, branchId: branchId || null };
    if (data.blockedReason) doc.blockedReason = data.blockedReason;
    try {
        return await Seat.create(doc);
    } catch (e) {
        throw duplicateSeatError(e, doc.seatNumber);
    }
};

const bulkCreateSeats = async (libraryId, seats, createdBy, branchId = null) => {
    const library = await Library.findById(libraryId).select('planLimits');
    const maxSeats = library?.planLimits?.maxSeats ?? 50;

    // Drop duplicates inside the payload itself
    const seen = new Set();
    const payloadDuplicates = [];
    const unique = [];
    for (const s of seats) {
        const num = String(s.seatNumber).trim();
        if (seen.has(num)) { payloadDuplicates.push(num); continue; }
        seen.add(num);
        unique.push({ ...pick(s, SEAT_CREATE_FIELDS), seatNumber: num, status: normaliseCreateStatus(s.status), libraryId, createdBy, branchId: branchId || null });
    }

    // Skip seat numbers that already exist
    const existing = await Seat.find({ libraryId, seatNumber: { $in: unique.map(u => u.seatNumber) } }).select('seatNumber');
    const existingSet = new Set(existing.map(e => e.seatNumber));
    const toInsert = unique.filter(u => !existingSet.has(u.seatNumber));

    const currentCount = await Seat.countDocuments({ libraryId, isDeleted: false });
    if (currentCount + toInsert.length > maxSeats) {
        throw new ApiError(403, `Seat limit reached (${maxSeats}). You have ${currentCount} seats and tried to add ${toInsert.length}. Upgrade your subscription plan to add more seats.`);
    }

    let created = [];
    const failed = [];
    if (toInsert.length) {
        try {
            created = await Seat.insertMany(toInsert, { ordered: false });
        } catch (e) {
            if (!e.insertedDocs && !e.writeErrors) throw e;
            created = e.insertedDocs || [];
            (e.writeErrors || []).forEach(we => failed.push(we.err?.op?.seatNumber || we.errmsg || 'unknown'));
        }
        // Re-check the limit after insert (concurrent bulk calls); roll back this batch if exceeded
        const after = await Seat.countDocuments({ libraryId, isDeleted: false });
        if (after > maxSeats && created.length) {
            await Seat.deleteMany({ _id: { $in: created.map(c => c._id) }, studentId: null });
            throw new ApiError(403, `Seat limit reached (${maxSeats}). Bulk creation was rolled back.`);
        }
    }

    return {
        createdCount: created.length,
        skippedCount: existingSet.size + payloadDuplicates.length + failed.length,
        created,
        skipped: {
            alreadyExisting: [...existingSet],
            duplicateInRequest: payloadDuplicates,
            failed
        }
    };
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
const getSeats = async (filter = {}, options = {}) => {
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit) || 100, 1), 500);
    const skip = (page - 1) * limit;

    const [seats, total] = await Promise.all([
        Seat.find(filter)
            .populate('studentId', 'name mobile planId expiryDate planStatus registrationNumber')
            .populate('reservedFor', 'name mobile')
            .sort({ floor: 1, room: 1, seatNumber: 1 })
            .collation({ locale: 'en', numericOrdering: true })
            .skip(skip).limit(limit),
        Seat.countDocuments(filter)
    ]);

    return { seats, total, page, limit, totalPages: Math.ceil(total / limit) };
};

const getSeatById = async (id, libraryId) => {
    if (!isValidId(id)) throw new ApiError(404, 'Seat not found');
    const seat = await Seat.findOne({ _id: id, libraryId })
        .populate('studentId', 'name mobile planId expiryDate planStatus')
        .populate('reservedFor', 'name mobile');
    if (!seat) throw new ApiError(404, 'Seat not found');
    return seat;
};

// `scope` is a branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
const getSeatStats = async (libraryId, scope = {}) => {
    const stats = await Seat.aggregate([
        { $match: { libraryId: oid(libraryId), isDeleted: false, ...scope } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const result = { total: 0, available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 };
    stats.forEach(s => { result[s._id] = s.count; result.total += s.count; });
    result.occupancyPercentage = result.total ? Math.round((result.occupied / result.total) * 10000) / 100 : 0;
    // Share of bookable seats (excluding blocked/maintenance) that are taken
    const usable = result.total - result.blocked - result.maintenance;
    result.utilizationPercentage = usable > 0 ? Math.round(((result.occupied + result.reserved) / usable) * 10000) / 100 : 0;
    return result;
};

/** Public helper for the library website: seat availability counts only. */
const getPublicAvailability = async (libraryId, scope = {}) => {
    const s = await getSeatStats(libraryId, scope);
    return { total: s.total, available: s.available, occupied: s.occupied };
};

/** Seats grouped by floor and room for a visual seat map. */
const getLayout = async (libraryId, scope = {}) => {
    const seats = await Seat.find({ libraryId, ...scope })
        .populate('studentId', 'name mobile expiryDate planStatus')
        .populate('reservedFor', 'name')
        .sort({ seatNumber: 1 })
        .collation({ locale: 'en', numericOrdering: true });

    const floors = new Map();
    for (const seat of seats) {
        const floorName = seat.floor || 'Ground Floor';
        const roomName = seat.room || 'Main Hall';
        if (!floors.has(floorName)) floors.set(floorName, new Map());
        const rooms = floors.get(floorName);
        if (!rooms.has(roomName)) rooms.set(roomName, []);
        rooms.get(roomName).push(seat);
    }

    const summarize = (list) => list.reduce((a, s) => { a.total++; a[s.status] = (a[s.status] || 0) + 1; return a; },
        { total: 0, available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 });

    return [...floors.entries()].map(([floor, rooms]) => {
        const roomList = [...rooms.entries()].map(([room, list]) => ({ room, summary: summarize(list), seats: list }));
        return { floor, summary: summarize(roomList.flatMap(r => r.seats)), rooms: roomList };
    });
};

const getSeatHistory = async (seatId, libraryId, options = {}) => {
    if (!isValidId(seatId)) throw new ApiError(404, 'Seat not found');
    const seat = await Seat.findOne({ _id: seatId, libraryId }).select('_id');
    if (!seat) throw new ApiError(404, 'Seat not found');
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit) || 50, 1), 200);
    const [results, total] = await Promise.all([
        SeatHistory.find({ seatId, libraryId }).sort({ at: -1 }).skip((page - 1) * limit).limit(limit)
            .populate('studentId', 'name mobile registrationNumber')
            .populate('relatedSeatId', 'seatNumber'),
        SeatHistory.countDocuments({ seatId, libraryId })
    ]);
    return { results, total, page, limit, totalPages: Math.ceil(total / limit) };
};

/**
 * Occupied seats that look recoverable: student's plan expired / not active,
 * or no attendance in the last `days` days.
 */
const getRecoveryList = async (libraryId, days = 7, scope = {}) => {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const seats = await Seat.find({ libraryId, ...scope, status: 'occupied', studentId: { $ne: null } })
        .populate('studentId', 'name mobile planStatus expiryDate status joiningDate registrationNumber');
    const studentIds = seats.map(s => s.studentId?._id).filter(Boolean);
    if (!studentIds.length) return { days, count: 0, results: [] };

    const recent = await Attendance.aggregate([
        { $match: { libraryId: oid(libraryId), studentId: { $in: studentIds }, date: { $gte: since } } },
        { $group: { _id: '$studentId', last: { $max: '$date' }, visits: { $sum: 1 } } }
    ]);
    const recentSet = new Set(recent.map(r => String(r._id)));

    const lastEver = await Attendance.aggregate([
        { $match: { libraryId: oid(libraryId), studentId: { $in: studentIds } } },
        { $group: { _id: '$studentId', last: { $max: '$date' } } }
    ]);
    const lastMap = new Map(lastEver.map(r => [String(r._id), r.last]));

    const results = [];
    for (const seat of seats) {
        const st = seat.studentId;
        if (!st) continue;
        const reasons = [];
        const expired = st.planStatus === 'expired' || (st.expiryDate && st.expiryDate < now);
        if (expired) reasons.push('plan_expired');
        else if (st.planStatus !== 'active' && st.planStatus !== 'paused') reasons.push('no_active_plan');
        const joinedRecently = st.joiningDate && st.joiningDate > since;
        if (!recentSet.has(String(st._id)) && !joinedRecently) reasons.push(`no_attendance_${days}_days`);
        if (reasons.length) {
            results.push({
                seat: { _id: seat._id, seatNumber: seat.seatNumber, floor: seat.floor, room: seat.room, assignedAt: seat.assignedAt },
                student: st,
                lastAttendance: lastMap.get(String(st._id)) || null,
                reasons
            });
        }
    }
    return { days, count: results.length, results };
};

// ---------------------------------------------------------------------------
// Update / status
// ---------------------------------------------------------------------------
const updateSeat = async (id, libraryId, data) => {
    if (!isValidId(id)) throw new ApiError(404, 'Seat not found');
    const update = pick(data, SEAT_UPDATE_FIELDS);
    if (!Object.keys(update).length) throw new ApiError(400, 'No updatable fields provided');
    try {
        const seat = await Seat.findOneAndUpdate(
            { _id: id, libraryId, isDeleted: false },
            { $set: update },
            { new: true, runValidators: true }
        );
        if (!seat) throw new ApiError(404, 'Seat not found');
        // Keep denormalised seatNumber on the student in sync
        if (update.seatNumber && seat.studentId) {
            await Student.updateOne({ _id: seat.studentId, libraryId }, { $set: { seatNumber: seat.seatNumber } });
        }
        return seat;
    } catch (e) {
        throw duplicateSeatError(e, update.seatNumber);
    }
};

/** Mark seat blocked / maintenance, or return it to service ('available'). */
const setSeatStatus = async (id, libraryId, status, reason, actor) => {
    if (!isValidId(id)) throw new ApiError(404, 'Seat not found');
    let seat;
    if (status === 'blocked' || status === 'maintenance') {
        seat = await Seat.findOneAndUpdate(
            { _id: id, libraryId, isDeleted: false, status: { $in: ['available', 'reserved', 'blocked', 'maintenance'] } },
            { $set: { status, blockedReason: reason || '', ...CLEAR_RESERVATION } },
            { new: true }
        );
        if (!seat) {
            const exists = await Seat.findOne({ _id: id, libraryId });
            if (!exists) throw new ApiError(404, 'Seat not found');
            throw new ApiError(400, 'An occupied seat must be released before it can be blocked or put under maintenance');
        }
        await logSeat(libraryId, seat, status, { reason, actor });
    } else if (status === 'available') {
        seat = await Seat.findOneAndUpdate(
            { _id: id, libraryId, isDeleted: false, status: { $in: ['blocked', 'maintenance'] } },
            { $set: { status: 'available', blockedReason: null } },
            { new: true }
        );
        if (!seat) {
            const exists = await Seat.findOne({ _id: id, libraryId });
            if (!exists) throw new ApiError(404, 'Seat not found');
            throw new ApiError(400, 'Only blocked or maintenance seats can be returned to service');
        }
        await logSeat(libraryId, seat, 'unblocked', { reason, actor });
    } else {
        throw new ApiError(400, 'Invalid status');
    }
    return seat;
};

// ---------------------------------------------------------------------------
// Assign / release / transfer / reserve
// ---------------------------------------------------------------------------
const loadStudentForSeat = async (studentId, libraryId) => {
    if (!isValidId(studentId)) throw new ApiError(404, 'Student not found');
    const student = await Student.findOne({ _id: studentId, libraryId });
    if (!student) throw new ApiError(404, 'Student not found in this library');
    if (student.status === 'suspended' || student.status === 'inactive') {
        throw new ApiError(400, `Cannot assign a seat to a ${student.status} student`);
    }
    return student;
};

const assertPlanEligible = async (student, seat, libraryId) => {
    // A student of one branch cannot take a seat of another branch
    if (student.branchId && seat.branchId && String(student.branchId) !== String(seat.branchId)) {
        throw new ApiError(400, 'This seat belongs to a different branch than the student');
    }
    if (!student.planId) return;
    const plan = await Plan.findOne({ _id: student.planId, libraryId });
    if (plan && !isSeatTypeEligible(plan, seat)) {
        throw new ApiError(400, `The student's plan "${plan.name}" is not eligible for ${seat.type} seats`);
    }
};

/** Atomically claim a seat for a student (available, or reserved for that student / reservation lapsed). */
const claimSeat = async (seatId, libraryId, studentId) => {
    const now = new Date();
    return Seat.findOneAndUpdate(
        {
            _id: seatId, libraryId, isDeleted: false,
            $or: [
                { status: 'available' },
                { status: 'reserved', reservedFor: studentId },
                { status: 'reserved', reservedUntil: { $lte: now } }
            ]
        },
        { $set: { status: 'occupied', studentId, assignedAt: now, ...CLEAR_RESERVATION } },
        { new: true }
    );
};

const revertClaim = async (seat, libraryId) => {
    // Best-effort rollback of a claim made in this request
    await Seat.updateOne(
        { _id: seat._id, libraryId, studentId: seat.studentId, status: 'occupied' },
        { $set: { status: 'available', studentId: null, assignedAt: null } }
    );
};

/** Release every seat held by the student except `exceptSeatId`. */
const releaseOtherSeats = async (studentId, libraryId, exceptSeatId, actor, action = 'released', reason) => {
    const query = { studentId, libraryId, status: 'occupied' };
    if (exceptSeatId) query._id = { $ne: exceptSeatId };
    const held = await Seat.find(query);
    for (const s of held) {
        const freed = await Seat.findOneAndUpdate(
            { _id: s._id, libraryId, studentId, status: 'occupied' },
            { $set: { status: 'available', studentId: null, assignedAt: null } },
            { new: true }
        );
        if (freed) await logSeat(libraryId, s, action, { studentId, actor, reason });
    }
};

const assignSeat = async (seatId, studentId, libraryId, actor = null) => {
    if (!isValidId(seatId)) throw new ApiError(404, 'Seat not found');
    const student = await loadStudentForSeat(studentId, libraryId);

    const seatDoc = await Seat.findOne({ _id: seatId, libraryId });
    if (!seatDoc) throw new ApiError(404, 'Seat not found');
    if (seatDoc.status === 'occupied' && String(seatDoc.studentId) === String(student._id)) return seatDoc; // idempotent
    await assertPlanEligible(student, seatDoc, libraryId);

    const seat = await claimSeat(seatId, libraryId, student._id);
    if (!seat) {
        const fresh = await Seat.findOne({ _id: seatId, libraryId });
        if (fresh?.status === 'reserved') throw new ApiError(400, 'Seat is reserved for another student');
        if (fresh?.status === 'blocked' || fresh?.status === 'maintenance') throw new ApiError(400, `Seat is currently ${fresh.status}`);
        throw new ApiError(400, 'Seat is already occupied');
    }

    try {
        await Student.updateOne({ _id: student._id, libraryId }, { $set: { seatNumber: seat.seatNumber, seatId: seat._id } });
    } catch (e) {
        await revertClaim(seat, libraryId);
        throw e;
    }

    await releaseOtherSeats(student._id, libraryId, seat._id, actor, 'released', 'Reassigned to another seat');
    await logSeat(libraryId, seat, 'assigned', { studentId: student._id, actor });
    notifySeat(libraryId, student._id, 'assigned', seat.seatNumber);
    return seat;
};

/**
 * Release (or cancel a reservation on) a seat.
 * action: 'released' (manual) | 'auto_released' (cron)
 */
const releaseSeat = async (seatId, libraryId, actor = null, { reason, action = 'released' } = {}) => {
    if (!isValidId(seatId)) throw new ApiError(404, 'Seat not found');
    const before = await Seat.findOne({ _id: seatId, libraryId });
    if (!before) throw new ApiError(404, 'Seat not found');
    if (before.status !== 'occupied' && before.status !== 'reserved') throw new ApiError(400, 'Seat is not occupied or reserved');

    const seat = await Seat.findOneAndUpdate(
        { _id: seatId, libraryId, status: before.status, studentId: before.studentId, isDeleted: false },
        { $set: { status: 'available', studentId: null, assignedAt: null, ...CLEAR_RESERVATION } },
        { new: true }
    );
    if (!seat) throw new ApiError(409, 'Seat state changed, please retry');

    if (before.studentId) {
        await Student.updateOne({ _id: before.studentId, libraryId, seatId: before._id }, { $set: { seatNumber: null, seatId: null } });
    }
    await logSeat(libraryId, before, before.status === 'reserved' ? 'reservation_cancelled' : action,
        { studentId: before.studentId || before.reservedFor, actor, reason });
    // auto_released has its own cron notice; only manual releases notify here
    if (before.status === 'occupied' && action === 'released') notifySeat(libraryId, before.studentId, 'released', before.seatNumber);
    return seat;
};

/** Release whatever seat(s) a student holds. Returns number of seats freed. */
const releaseSeatForStudent = async (studentId, libraryId, { actor = null, reason, action = 'released' } = {}) => {
    const held = await Seat.find({ libraryId, studentId, status: 'occupied' });
    let freed = 0;
    for (const s of held) {
        const r = await Seat.findOneAndUpdate(
            { _id: s._id, libraryId, studentId, status: 'occupied' },
            { $set: { status: 'available', studentId: null, assignedAt: null } },
            { new: true }
        );
        if (r) { freed++; await logSeat(libraryId, s, action, { studentId, actor, reason }); }
    }
    // Also clear dangling pointers on the student
    await Student.updateOne({ _id: studentId, libraryId }, { $set: { seatNumber: null, seatId: null } });
    // Cancel any reservations held for the student
    await Seat.updateMany({ libraryId, status: 'reserved', reservedFor: studentId },
        { $set: { status: 'available', ...CLEAR_RESERVATION } });
    return freed;
};

const transferSeat = async (studentId, toSeatId, libraryId, actor = null, reason) => {
    if (!isValidId(toSeatId)) throw new ApiError(404, 'Target seat not found');
    const student = await loadStudentForSeat(studentId, libraryId);
    const fromSeat = await Seat.findOne({ libraryId, studentId: student._id, status: 'occupied' });
    if (!fromSeat) throw new ApiError(400, 'Student does not currently hold a seat');
    if (String(fromSeat._id) === String(toSeatId)) throw new ApiError(400, 'Student already occupies this seat');

    const target = await Seat.findOne({ _id: toSeatId, libraryId });
    if (!target) throw new ApiError(404, 'Target seat not found');
    await assertPlanEligible(student, target, libraryId);

    const claimed = await claimSeat(toSeatId, libraryId, student._id);
    if (!claimed) throw new ApiError(400, `Target seat is not available (currently ${target.status})`);

    try {
        await Student.updateOne({ _id: student._id, libraryId }, { $set: { seatNumber: claimed.seatNumber, seatId: claimed._id } });
        const freed = await Seat.findOneAndUpdate(
            { _id: fromSeat._id, libraryId, studentId: student._id, status: 'occupied' },
            { $set: { status: 'available', studentId: null, assignedAt: null } },
            { new: true }
        );
        if (!freed) throw new ApiError(409, 'Source seat changed during transfer');
    } catch (e) {
        await revertClaim(claimed, libraryId);
        await Student.updateOne({ _id: student._id, libraryId }, { $set: { seatNumber: fromSeat.seatNumber, seatId: fromSeat._id } });
        throw e;
    }

    await logSeat(libraryId, fromSeat, 'transfer_out', { studentId: student._id, relatedSeatId: claimed._id, actor, reason });
    await logSeat(libraryId, claimed, 'transfer_in', { studentId: student._id, relatedSeatId: fromSeat._id, actor, reason });
    notifySeat(libraryId, student._id, 'transferred', claimed.seatNumber);
    return { from: fromSeat.seatNumber, to: claimed };
};

const reserveSeat = async (seatId, libraryId, { studentId, until, reason }, actor = null) => {
    if (!isValidId(seatId)) throw new ApiError(404, 'Seat not found');
    const student = await loadStudentForSeat(studentId, libraryId);
    const untilDate = new Date(until);
    if (isNaN(untilDate.getTime()) || untilDate <= new Date()) throw new ApiError(400, 'Reservation end time must be in the future');
    // Same rule as assigning: a hold the student could never take up must not be accepted
    const target = await Seat.findOne({ _id: seatId, libraryId });
    if (target) await assertPlanEligible(student, target, libraryId);

    const seat = await Seat.findOneAndUpdate(
        { _id: seatId, libraryId, isDeleted: false, status: 'available' },
        { $set: { status: 'reserved', reservedFor: student._id, reservedUntil: untilDate, reservedReason: reason || '' } },
        { new: true }
    );
    if (!seat) {
        const exists = await Seat.findOne({ _id: seatId, libraryId });
        if (!exists) throw new ApiError(404, 'Seat not found');
        throw new ApiError(400, `Seat is ${exists.status} and cannot be reserved`);
    }
    await logSeat(libraryId, seat, 'reserved', { studentId: student._id, actor, reason: reason || `Reserved until ${untilDate.toISOString()}` });
    return seat;
};

const deleteSeat = async (id, libraryId) => {
    if (!isValidId(id)) throw new ApiError(404, 'Seat not found');
    const seat = await Seat.findOneAndUpdate(
        { _id: id, libraryId, isDeleted: false, status: { $ne: 'occupied' } },
        { $set: { isDeleted: true, status: 'available', ...CLEAR_RESERVATION } },
        { new: true }
    );
    if (!seat) {
        const exists = await Seat.findOne({ _id: id, libraryId });
        if (!exists) throw new ApiError(404, 'Seat not found');
        throw new ApiError(400, 'Cannot delete an occupied seat. Release it first.');
    }
    return seat;
};

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------
/** Free seats whose temporary reservation lapsed. */
const expireReservations = async (libraryId = null) => {
    const now = new Date();
    const query = { status: 'reserved', reservedUntil: { $ne: null, $lte: now }, isDeleted: false };
    if (libraryId) query.libraryId = libraryId;
    const lapsed = await Seat.find(query);
    let count = 0;
    for (const s of lapsed) {
        const r = await Seat.findOneAndUpdate(
            { _id: s._id, status: 'reserved', reservedUntil: { $lte: now } },
            { $set: { status: 'available', ...CLEAR_RESERVATION } },
            { new: true }
        );
        if (r) { count++; await logSeat(s.libraryId, s, 'reservation_expired', { studentId: s.reservedFor, reason: 'Reservation period ended' }); }
    }
    return count;
};

module.exports = {
    createSeat, bulkCreateSeats, getSeats, getSeatById, updateSeat, setSeatStatus,
    assignSeat, releaseSeat, releaseSeatForStudent, transferSeat, reserveSeat, deleteSeat,
    getSeatStats, getPublicAvailability, getLayout, getSeatHistory, getRecoveryList,
    expireReservations, isSeatTypeEligible, checkSeatLimit, actorOf
};

// ---- Live dashboards (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
const seatEvent = (libraryIndex) => (args, r) => {
    const seat = (r && (r.seat || r)) || {};
    realtime.seatChanged({ libraryId: args[libraryIndex] || seat.libraryId, branchId: seat.branchId || null, seatId: seat._id || null, status: seat.status || 'released' });
};
const seatFns = { createSeat: 0, bulkCreateSeats: 0, updateSeat: 1, setSeatStatus: 1, assignSeat: 2, releaseSeat: 1, releaseSeatForStudent: 1, transferSeat: 2, reserveSeat: 1, deleteSeat: 1 };
for (const [name, libraryIndex] of Object.entries(seatFns)) module.exports[name] = realtime.after(module.exports[name], seatEvent(libraryIndex));
