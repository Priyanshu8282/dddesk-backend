const Attendance = require('./attendance.model');
const Student = require('../students/student.model');
const ApiError = require('../../utils/ApiError');

/**
 * Punch In
 * @param {ObjectId} studentId
 * @param {ObjectId} libraryId
 * @returns {Promise<Attendance>}
 */
const punchIn = async (studentId, libraryId) => {
    const student = await Student.findById(studentId);
    if (!student) {
        throw new ApiError(404, 'Student not found');
    }

    // Check if membership is active and not expired
    if (student.status !== 'active') {
        throw new ApiError(403, 'Your account is not active. Please contact administrator.');
    }

    // Check if student has a plan
    if (!student.planId || student.planStatus !== 'active') {
        throw new ApiError(403, 'No active membership plan found. Please purchase a plan to use the library.');
    }

    if (student.expiryDate && new Date(student.expiryDate) < new Date()) {
        throw new ApiError(403, 'Your membership has expired. Please renew your plan to continue using the library.');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check if already punched in today and not yet punched out
    const existingAttendance = await Attendance.findOne({
        studentId,
        date: today,
        checkOut: { $exists: false }
    });

    if (existingAttendance) {
        throw new ApiError(400, 'You are already punched in');
    }

    return Attendance.create({
        studentId,
        libraryId,
        date: today,
        checkIn: new Date(),
        status: 'present'
    });
};

/**
 * Punch Out
 * @param {ObjectId} studentId
 * @returns {Promise<Attendance>}
 */
const punchOut = async (studentId) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendance = await Attendance.findOne({
        studentId,
        checkOut: { $exists: false }
    }).sort({ createdAt: -1 });

    if (!attendance) {
        throw new ApiError(400, 'No active punch-in found');
    }

    const checkOutTime = new Date();
    const duration = Math.round((checkOutTime - attendance.checkIn) / (1000 * 60)); // in minutes

    attendance.checkOut = checkOutTime;
    attendance.duration = duration;
    await attendance.save();

    return attendance;
};

/**
 * Query for attendance
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of results per page
 * @param {number} [options.page] - Current page number
 * @returns {Promise<Object>}
 */
const queryAttendance = async (filter, options = {}) => {
    const { limit = 10, page = 1 } = options;
    const skip = (page - 1) * limit;

    const attendance = await Attendance.find(filter)
        .populate('studentId', 'name mobile rollNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Attendance.countDocuments(filter);
    const totalPages = Math.ceil(totalResults / limit);

    return {
        results: attendance,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages,
        totalResults
    };
};

module.exports = {
    punchIn,
    punchOut,
    queryAttendance
};
