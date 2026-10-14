const Seat = require('../models/seat.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');

const createSeat = async (data) => {
    const existing = await Seat.findOne({ libraryId: data.libraryId, seatNumber: data.seatNumber });
    if (existing) throw new ApiError(400, `Seat number "${data.seatNumber}" already exists in this library`);
    return Seat.create(data);
};

const bulkCreateSeats = async (libraryId, seats, createdBy) => {
    const docs = seats.map(s => ({ ...s, libraryId, createdBy }));
    return Seat.insertMany(docs, { ordered: false });
};

const getSeats = async (filter = {}, options = {}) => {
    const page = parseInt(options.page) || 1;
    const limit = parseInt(options.limit) || 100;
    const skip = (page - 1) * limit;

    const [seats, total] = await Promise.all([
        Seat.find(filter).populate('studentId', 'name mobile planId').sort({ seatNumber: 1 }).skip(skip).limit(limit),
        Seat.countDocuments(filter)
    ]);

    return { seats, total, page, totalPages: Math.ceil(total / limit) };
};

const getSeatById = async (id, libraryId) => {
    const seat = await Seat.findOne({ _id: id, libraryId }).populate('studentId', 'name mobile planId expiryDate');
    if (!seat) throw new ApiError(404, 'Seat not found');
    return seat;
};

const updateSeat = async (id, libraryId, data) => {
    const seat = await Seat.findOneAndUpdate(
        { _id: id, libraryId },
        { $set: data },
        { new: true, runValidators: true }
    );
    if (!seat) throw new ApiError(404, 'Seat not found');
    return seat;
};

const assignSeat = async (seatId, studentId, libraryId) => {
    const seat = await Seat.findOne({ _id: seatId, libraryId });
    if (!seat) throw new ApiError(404, 'Seat not found');
    if (seat.status === 'occupied') throw new ApiError(400, 'Seat is already occupied');
    if (seat.status === 'blocked' || seat.status === 'maintenance')
        throw new ApiError(400, `Seat is currently ${seat.status}`);

    // Release any previous seat the student holds
    await Seat.updateMany(
        { studentId, libraryId, status: 'occupied' },
        { $set: { status: 'available', studentId: null, assignedAt: null } }
    );

    seat.status = 'occupied';
    seat.studentId = studentId;
    seat.assignedAt = new Date();
    await seat.save();

    await Student.findByIdAndUpdate(studentId, { seatNumber: seat.seatNumber, seatId: seat._id });

    return seat;
};

const releaseSeat = async (seatId, libraryId) => {
    const seat = await Seat.findOne({ _id: seatId, libraryId });
    if (!seat) throw new ApiError(404, 'Seat not found');

    if (seat.studentId) {
        await Student.findByIdAndUpdate(seat.studentId, { $unset: { seatNumber: '', seatId: '' } });
    }

    seat.status = 'available';
    seat.studentId = null;
    seat.assignedAt = null;
    await seat.save();
    return seat;
};

const deleteSeat = async (id, libraryId) => {
    const seat = await Seat.findOne({ _id: id, libraryId });
    if (!seat) throw new ApiError(404, 'Seat not found');
    if (seat.status === 'occupied') throw new ApiError(400, 'Cannot delete an occupied seat. Release it first.');
    seat.isDeleted = true;
    await seat.save();
};

const getSeatStats = async (libraryId) => {
    const stats = await Seat.aggregate([
        { $match: { libraryId: require('mongoose').Types.ObjectId.createFromHexString(libraryId.toString()), isDeleted: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const result = { total: 0, available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 };
    stats.forEach(s => { result[s._id] = s.count; result.total += s.count; });
    return result;
};

module.exports = { createSeat, bulkCreateSeats, getSeats, getSeatById, updateSeat, assignSeat, releaseSeat, deleteSeat, getSeatStats };
