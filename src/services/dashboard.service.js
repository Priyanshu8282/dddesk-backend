const mongoose = require('mongoose');
const Student    = require('../models/student.model');
const Payment    = require('../models/payment.model');
const Attendance = require('../models/attendance.model');
const Seat       = require('../models/seat.model');
const Library    = require('../models/library.model');

exports.getAdminDashboardData = async (libraryId) => {
  const libId = new mongoose.Types.ObjectId(libraryId.toString());

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);
  const thirtyDaysOut = new Date(); thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const [
    totalStudents, activeStudents, trialStudents,
    expiringMemberships, expiredMemberships,
    todayAttendance, todayCollection, pendingFees,
    seatStats, recentPayments, monthlyCollection,
  ] = await Promise.all([
    Student.countDocuments({ libraryId }),
    Student.countDocuments({ libraryId, status: 'active', planStatus: 'active' }),
    Student.countDocuments({ libraryId, planStatus: 'none' }),
    Student.countDocuments({ libraryId, expiryDate: { $gte: today, $lte: thirtyDaysOut }, planStatus: 'active' }),
    Student.countDocuments({ libraryId, planStatus: 'expired' }),
    Attendance.countDocuments({ libraryId, date: { $gte: today, $lte: todayEnd } }),
    Payment.aggregate([
      { $match: { libraryId: libId, paymentDate: { $gte: today, $lte: todayEnd }, paymentStatus: { $in: ['paid','partial'] } } },
      { $group: { _id: null, total: { $sum: '$paidAmount' } } },
    ]),
    Payment.aggregate([
      { $match: { libraryId: libId, paymentStatus: { $in: ['partial','credit','overdue'] } } },
      { $group: { _id: null, total: { $sum: '$dueAmount' } } },
    ]),
    Seat.aggregate([
      { $match: { libraryId: libId, isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Payment.find({ libraryId }).sort({ createdAt: -1 }).limit(5).populate('studentId', 'name mobile'),
    Payment.aggregate([
      { $match: { libraryId: libId, paymentStatus: { $in: ['paid','partial'] } } },
      { $group: { _id: { year: { $year: '$paymentDate' }, month: { $month: '$paymentDate' } }, total: { $sum: '$paidAmount' } } },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 },
    ]),
  ]);

  const seats = { total: 0, available: 0, occupied: 0, reserved: 0, blocked: 0, maintenance: 0 };
  seatStats.forEach(s => { seats[s._id] = s.count; seats.total += s.count; });

  return {
    students: { total: totalStudents, active: activeStudents, trial: trialStudents, expiringIn30Days: expiringMemberships, expired: expiredMemberships },
    today:    { attendance: todayAttendance, collection: todayCollection[0]?.total || 0 },
    fees:     { pendingTotal: pendingFees[0]?.total || 0 },
    seats,
    recentPayments,
    monthlyCollection: monthlyCollection.reverse(),
  };
};

exports.getSuperAdminDashboardData = async () => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1); sixMonthsAgo.setHours(0, 0, 0, 0);

  const [
    totalLibraries, activeLibraries, pendingLibraries, suspendedLibraries, rejectedLibraries,
    totalStudents, activeStudents, totalRevenue,
    recentLibraries, monthlyRevenue, libraryTrend, occupiedSeats,
  ] = await Promise.all([
    Library.countDocuments({ isDeleted: false }),
    Library.countDocuments({ isDeleted: false, status: 'active' }),
    Library.countDocuments({ isDeleted: false, status: 'pending' }),
    Library.countDocuments({ isDeleted: false, status: 'suspended' }),
    Library.countDocuments({ isDeleted: false, status: 'rejected' }),
    Student.countDocuments(),
    Student.countDocuments({ status: 'active', planStatus: 'active' }),
    Payment.aggregate([
      { $match: { paymentStatus: { $in: ['paid','partial'] } } },
      { $group: { _id: null, total: { $sum: '$paidAmount' } } },
    ]),
    Library.find({ isDeleted: false }).sort({ createdAt: -1 }).limit(5)
      .select('name status city state createdAt subscriptionPlan'),
    Payment.aggregate([
      { $match: { paymentStatus: { $in: ['paid','partial'] }, createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, total: { $sum: '$paidAmount' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
    Library.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
    Seat.aggregate([{ $match: { status: 'occupied', isDeleted: false } }, { $count: 'total' }]),
  ]);

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    libraries: { total: totalLibraries, active: activeLibraries, pending: pendingLibraries, suspended: suspendedLibraries, rejected: rejectedLibraries },
    totalStudents, activeStudents,
    totalRevenue: totalRevenue[0]?.total || 0,
    occupiedSeats: occupiedSeats[0]?.total || 0,
    recentLibraries,
    monthlyRevenue: monthlyRevenue.map(r => ({ label: `${MONTHS[r._id.month-1]} ${r._id.year}`, total: r.total })),
    libraryTrend:   libraryTrend.map(r   => ({ label: `${MONTHS[r._id.month-1]} ${r._id.year}`, count: r.count })),
  };
};
