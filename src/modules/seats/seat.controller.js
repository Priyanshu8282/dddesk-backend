const catchAsync = require('../../utils/catchAsync');
const seatService = require('./seat.service');
const ApiError = require('../../utils/ApiError');
const Library = require('../libraries/library.model');
const Seat = require('./seat.model');

const checkSeatLimit = async (libraryId, requestingCount = 1) => {
    const library = await Library.findById(libraryId).select('planLimits');
    if (!library) return;
    const maxSeats = library.planLimits?.maxSeats ?? 50;
    const currentCount = await Seat.countDocuments({ libraryId, isDeleted: false });
    if (currentCount + requestingCount > maxSeats) {
        throw new ApiError(403, `Seat limit reached (${maxSeats}). Upgrade your subscription plan to add more seats.`);
    }
};

exports.createSeat = catchAsync(async (req, res) => {
    await checkSeatLimit(req.user.libraryId, 1);
    const seat = await seatService.createSeat({ ...req.body, libraryId: req.user.libraryId, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Seat created successfully', data: seat });
});

exports.bulkCreateSeats = catchAsync(async (req, res) => {
    const { seats } = req.body;
    if (!Array.isArray(seats) || seats.length === 0)
        throw new ApiError(400, 'seats array is required');
    await checkSeatLimit(req.user.libraryId, seats.length);
    const result = await seatService.bulkCreateSeats(req.user.libraryId, seats, req.user._id);
    res.status(201).json({ success: true, message: `${result.length} seats created`, data: result });
});

exports.getSeats = catchAsync(async (req, res) => {
    const filter = { libraryId: req.user.libraryId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.floor) filter.floor = req.query.floor;
    if (req.query.room) filter.room = req.query.room;
    if (req.query.type) filter.type = req.query.type;

    const result = await seatService.getSeats(filter, { page: req.query.page, limit: req.query.limit });
    const stats = await seatService.getSeatStats(req.user.libraryId);
    res.json({ success: true, ...result, stats });
});

exports.getSeatById = catchAsync(async (req, res) => {
    const seat = await seatService.getSeatById(req.params.id, req.user.libraryId);
    res.json({ success: true, data: seat });
});

exports.updateSeat = catchAsync(async (req, res) => {
    const seat = await seatService.updateSeat(req.params.id, req.user.libraryId, req.body);
    res.json({ success: true, message: 'Seat updated successfully', data: seat });
});

exports.assignSeat = catchAsync(async (req, res) => {
    const { studentId } = req.body;
    if (!studentId) throw new ApiError(400, 'studentId is required');
    const seat = await seatService.assignSeat(req.params.id, studentId, req.user.libraryId);
    res.json({ success: true, message: 'Seat assigned successfully', data: seat });
});

exports.releaseSeat = catchAsync(async (req, res) => {
    const seat = await seatService.releaseSeat(req.params.id, req.user.libraryId);
    res.json({ success: true, message: 'Seat released successfully', data: seat });
});

exports.deleteSeat = catchAsync(async (req, res) => {
    await seatService.deleteSeat(req.params.id, req.user.libraryId);
    res.json({ success: true, message: 'Seat deleted successfully' });
});

exports.getSeatStats = catchAsync(async (req, res) => {
    const stats = await seatService.getSeatStats(req.user.libraryId);
    res.json({ success: true, data: stats });
});
