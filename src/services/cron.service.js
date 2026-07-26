const cron = require('node-cron');
const Student = require('../modules/students/student.model');
const Attendance = require('../modules/attendance/attendance.model');
const Library = require('../modules/libraries/library.model');
const { notifyLibraryAdmins, notifyMultipleStudents } = require('./firebase.service');

const initCronJobs = () => {
    // Run daily at 10 AM
    cron.schedule('0 10 * * *', async () => {
        try {
            console.log('Running daily cron job: Plan Expiry & Attendance Alerts');

            const now = new Date();
            const threeDaysFromNow = new Date(now);
            threeDaysFromNow.setDate(now.getDate() + 3);

            // Group libraries
            const libraries = await Library.find({ status: 'active', isDeleted: false });

            for (const library of libraries) {
                // 1. Plan Expiry Alert
                const expiringStudents = await Student.find({
                    libraryId: library._id,
                    isDeleted: false,
                    planStatus: 'active',
                    expiryDate: { $gte: now, $lte: threeDaysFromNow }
                });

                if (expiringStudents.length > 0) {
                    notifyLibraryAdmins(
                        library._id,
                        "⚠ Plan Expiry Alert",
                        `${expiringStudents.length} student(s) plans expire within 3 days`
                    );
                    await notifyMultipleStudents(
                        expiringStudents.map(s => s._id),
                        "⚠ Membership Expiring Soon",
                        "Renew your plan before expiry",
                        {},
                        'plan_alert'
                    );
                }

                // 2. Plan Expired
                const expiredStudents = await Student.find({
                    libraryId: library._id,
                    isDeleted: false,
                    planStatus: 'active',
                    expiryDate: { $lt: now }
                });

                if (expiredStudents.length > 0) {
                    for(const s of expiredStudents) {
                        s.planStatus = 'expired';
                        await s.save();
                    }
                    await notifyMultipleStudents(
                        expiredStudents.map(s => s._id),
                        "❌ Membership Expired",
                        "Please renew your membership",
                        {},
                        'plan_alert'
                    );
                }

                // 3. Fees Reminder
                // Remind students whose payment is pending
                const pendingFeeStudents = await Student.find({
                    libraryId: library._id,
                    isDeleted: false,
                    paymentStatus: 'pending'
                });

                if (pendingFeeStudents.length > 0) {
                    await notifyMultipleStudents(
                        pendingFeeStudents.map(s => s._id),
                        "💳 Fees Reminder",
                        "Please pay your pending fees",
                        {},
                        'fee_alert'
                    );
                }

                // 4. Attendance Alert
                const twoDaysAgo = new Date(now);
                twoDaysAgo.setDate(now.getDate() - 2);
                twoDaysAgo.setHours(0,0,0,0);

                const activeStudents = await Student.find({ libraryId: library._id, status: 'active', isDeleted: false });
                
                for (const student of activeStudents) {
                    const recentAttendance = await Attendance.countDocuments({
                        studentId: student._id,
                        date: { $gte: twoDaysAgo }
                    });

                    if (recentAttendance === 0) {
                        notifyLibraryAdmins(
                            library._id,
                            "📅 Attendance Alert",
                            `${student.name} absent for 2 consecutive days`
                        );
                    }
                }
            }
        } catch (err) {
            console.error('Error in daily cron jobs:', err);
        }
    });
};

module.exports = { initCronJobs };
