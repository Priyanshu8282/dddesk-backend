const catchAsync = require('../utils/catchAsync');
const seatService = require('../services/seat.service');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const Seat = require('../models/seat.model');
const { branchFilter, assertBranchAccess, branchForCreate } = require('../utils/branchScope');

// Branch-limited staff may only touch seats of their own branches
const guardSeat = async (req, id) => {
    if (req.userType !== 'staff') return;
    const seat = await Seat.findOne({ _id: id, libraryId: lib(req) }).select('branchId').lean();
    if (seat) assertBranchAccess(req, seat.branchId);
};

const lib = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context is required');
    return id;
};

exports.createSeat = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const branchId = await branchForCreate(req, libraryId, req.body.branchId);
    const seat = await seatService.createSeat(libraryId, req.body, req.user._id, branchId);
    audit(req, 'seat.create', 'Seat', seat._id, { seatNumber: seat.seatNumber });
    res.status(201).json({ success: true, message: 'Seat created successfully', data: seat });
});

exports.bulkCreateSeats = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    let { seats, prefix = 'S-', startNumber = 1, count, floor = 'Ground Floor', room = 'Main Hall', type = 'standard', price = 0 } = req.body;
    if (!seats && count) {
        seats = [];
        for (let i = 0; i < count; i++) {
            seats.push({ seatNumber: `${prefix}${startNumber + i}`, floor, room, type, price });
        }
    }
    if (!Array.isArray(seats) || seats.length === 0) throw new ApiError(400, 'seats array or valid count is required');

    const branchId = await branchForCreate(req, libraryId, req.body.branchId);
    const result = await seatService.bulkCreateSeats(libraryId, seats, req.user._id, branchId);
    audit(req, 'seat.bulk_create', 'Seat', null, { created: result.createdCount, skipped: result.skippedCount });
    res.status(201).json({
        success: true,
        message: `${result.createdCount} seats created, ${result.skippedCount} skipped`,
        data: result.created,
        summary: {
            created: result.createdCount,
            skipped: result.skippedCount,
            skippedDetails: result.skipped
        }
    });
});

exports.getSeats = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const scope = branchFilter(req);
    const filter = { libraryId, ...scope };
    ['status', 'floor', 'room', 'type'].forEach((k) => { if (req.query[k]) filter[k] = String(req.query[k]); });

    const result = await seatService.getSeats(filter, { page: req.query.page, limit: req.query.limit });
    const stats = await seatService.getSeatStats(libraryId, scope);
    res.status(200).json({
        success: true,
        message: 'Seats retrieved successfully',
        data: result.seats,
        ...result,
        stats
    });
});

exports.getSeatStats = catchAsync(async (req, res) => {
    const stats = await seatService.getSeatStats(lib(req), branchFilter(req));
    res.status(200).json({ success: true, message: 'Seat statistics retrieved successfully', data: stats });
});

exports.getLayout = catchAsync(async (req, res) => {
    const data = await seatService.getLayout(lib(req), branchFilter(req));
    res.status(200).json({ success: true, message: 'Seat layout retrieved successfully', data });
});

exports.getRecovery = catchAsync(async (req, res) => {
    const data = await seatService.getRecoveryList(lib(req), req.query.days || 7, branchFilter(req));
    res.status(200).json({ success: true, message: 'Seat recovery list retrieved successfully', data });
});

exports.getSeatById = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await seatService.getSeatById(req.params.id, lib(req));
    res.status(200).json({ success: true, message: 'Seat retrieved successfully', data: seat });
});

exports.getSeatHistory = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const data = await seatService.getSeatHistory(req.params.id, lib(req), req.query);
    res.status(200).json({ success: true, message: 'Seat history retrieved successfully', data: data.results, ...data });
});

exports.updateSeat = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await seatService.updateSeat(req.params.id, lib(req), req.body);
    audit(req, 'seat.update', 'Seat', seat._id, { fields: Object.keys(req.body) });
    res.status(200).json({ success: true, message: 'Seat updated successfully', data: seat });
});

exports.setSeatStatus = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const { status, reason } = req.body;
    const seat = await seatService.setSeatStatus(req.params.id, lib(req), status, reason, seatService.actorOf(req));
    audit(req, 'seat.status', 'Seat', seat._id, { status, reason });
    res.status(200).json({ success: true, message: `Seat marked ${status}`, data: seat });
});

exports.assignSeat = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await require('../utils/securityEvent').flagOnMiss(req, require('../models/student.model'), req.body.studentId, 'Student',
        () => seatService.assignSeat(req.params.id, req.body.studentId, lib(req), seatService.actorOf(req)));
    audit(req, 'seat.assign', 'Seat', seat._id, { studentId: req.body.studentId });
    res.status(200).json({ success: true, message: 'Seat assigned successfully', data: seat });
});

exports.releaseSeat = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await seatService.releaseSeat(req.params.id, lib(req), seatService.actorOf(req), { reason: req.body?.reason });
    audit(req, 'seat.release', 'Seat', seat._id, { reason: req.body?.reason });
    res.status(200).json({ success: true, message: 'Seat released successfully', data: seat });
});

exports.transferSeat = catchAsync(async (req, res) => {
    const { studentId, toSeatId, reason } = req.body;
    await guardSeat(req, toSeatId);
    const result = await seatService.transferSeat(studentId, toSeatId, lib(req), seatService.actorOf(req), reason);
    audit(req, 'seat.transfer', 'Seat', result.to._id, { studentId, from: result.from, to: result.to.seatNumber, reason });
    res.status(200).json({ success: true, message: 'Seat transferred successfully', data: result.to, from: result.from });
});

exports.reserveSeat = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await seatService.reserveSeat(req.params.id, lib(req), req.body, seatService.actorOf(req));
    audit(req, 'seat.reserve', 'Seat', seat._id, { studentId: req.body.studentId, until: req.body.until });
    res.status(200).json({ success: true, message: 'Seat reserved successfully', data: seat });
});

exports.deleteSeat = catchAsync(async (req, res) => {
    await guardSeat(req, req.params.id);
    const seat = await seatService.deleteSeat(req.params.id, lib(req));
    audit(req, 'seat.delete', 'Seat', seat._id, { seatNumber: seat.seatNumber });
    res.status(200).json({ success: true, message: 'Seat deleted successfully' });
});
