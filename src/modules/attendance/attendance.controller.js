const catchAsync = require('../../utils/catchAsync');
const attendanceService = require('./attendance.service');
const Student = require('../students/student.model');
const DailyCode = require('./dailyCode.model');

const { notifyLibraryAdmins, notifyStudent } = require('../../services/firebase.service');

const punchIn = catchAsync(async (req, res) => {
    // If student is logged in, use their ID. If admin is punching in for student, use ID from body.
    const studentId = req.userType === 'student' ? req.user.id : req.body?.studentId;
    const libraryId = req.user.libraryId;

    const student = await Student.findById(studentId);
    if (!student) {
        return res.status(404).send({ success: false, message: 'Student not found' });
    }

    if (student.planStatus !== 'active') {
        return res.status(400).send({ success: false, message: 'Active plan required to punch in' });
    }

    if (req.userType === 'student') {
        const { code } = req.body;
        if (!code) {
            return res.status(400).send({ success: false, message: 'Daily code is required' });
        }
        const dateStr = new Date().toISOString().split('T')[0];
        const dailyCode = await DailyCode.findOne({ studentId, libraryId, date: dateStr });
        if (!dailyCode || dailyCode.code.toUpperCase() !== code.toUpperCase()) {
            return res.status(400).send({ success: false, message: 'Invalid daily code' });
        }
    }
    
    const attendance = await attendanceService.punchIn(studentId, libraryId);

    console.log(`[ATTENDANCE DEBUG] punchIn called. studentId: ${studentId}, libraryId:`, libraryId);
    if (student) {
        console.log(`[ATTENDANCE DEBUG] Found student ${student.name}. Calling notifyLibraryAdmins...`);
        notifyLibraryAdmins(
            libraryId,
            "🟢 Attendance: Punch In",
            `${student.name} punched in successfully.`,
            {},
            'attendance_alert'
        );
        notifyStudent(
            studentId,
            "✅ Attendance Marked Successfully",
            "You have punched in successfully.",
            {},
            'attendance_alert'
        );
    } else {
        console.log(`[ATTENDANCE DEBUG] Student not found for ID: ${studentId}`);
    }

    res.status(201).send({
        success: true,
        message: 'Punched in successfully',
        data: attendance
    });
});

const punchOut = catchAsync(async (req, res) => {
    const studentId = req.userType === 'student' ? req.user.id : req.body?.studentId;

    const student = await Student.findById(studentId);
    if (!student) {
        return res.status(404).send({ success: false, message: 'Student not found' });
    }

    if (student.planStatus !== 'active') {
        return res.status(400).send({ success: false, message: 'Active plan required to punch out' });
    }

    if (req.userType === 'student') {
        const { code } = req.body;
        if (!code) {
            return res.status(400).send({ success: false, message: 'Daily code is required' });
        }
        const libraryId = req.user.libraryId;
        const dateStr = new Date().toISOString().split('T')[0];
        const dailyCode = await DailyCode.findOne({ studentId, libraryId, date: dateStr });
        if (!dailyCode || dailyCode.code.toUpperCase() !== code.toUpperCase()) {
            return res.status(400).send({ success: false, message: 'Invalid daily code' });
        }
    }

    const attendance = await attendanceService.punchOut(studentId);

    console.log(`[ATTENDANCE DEBUG] punchOut called. studentId: ${studentId}, attendance.libraryId:`, attendance.libraryId);
    if (student && attendance.libraryId) {
        console.log(`[ATTENDANCE DEBUG] Found student ${student.name} and libraryId. Calling notifyLibraryAdmins...`);
        notifyLibraryAdmins(
            attendance.libraryId,
            "🔴 Attendance: Punch Out",
            `${student.name} punched out successfully.`,
            {},
            'attendance_alert'
        );
        notifyStudent(
            studentId,
            "✅ Attendance Marked Successfully",
            "You have punched out successfully.",
            {},
            'attendance_alert'
        );
    } else {
        console.log(`[ATTENDANCE DEBUG] Could not send punchOut notification. student exists: ${!!student}, libraryId: ${attendance.libraryId}`);
    }

    res.status(200).send({
        success: true,
        message: 'Punched out successfully',
        data: attendance
    });
});

const getAttendance = catchAsync(async (req, res) => {
    const libraryId = req.user.libraryId;
    
    // Parse pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    // Date Filtering Setup
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

    // Handle student queries (Student Dashboard)
    const targetStudentId = req.userType === 'student' ? req.user.id : req.query.studentId;
    if (targetStudentId) {
        const filter = { studentId: targetStudentId, ...dateFilter };
        if (libraryId && req.userType !== 'superadmin') {
            filter.libraryId = libraryId;
        }

        const result = await attendanceService.queryAttendance(filter, { page, limit });
        
        // Format student's records to unified top-level format
        const formattedResults = result.results.map(att => ({
            _id: att._id.toString(),
            name: att.studentId?.name || req.user.name || 'Unknown Student',
            rollNumber: att.studentId?.rollNumber || req.user.rollNumber || 'N/A',
            mobile: att.studentId?.mobile || req.user.mobile || '',
            status: att.checkOut ? 'PRESENT' : 'INSIDE',
            checkIn: att.checkIn,
            checkOut: att.checkOut,
            duration: att.duration,
            profileImage: att.studentId?.profileImage || req.user.profileImage,
            date: att.date
        }));

        // Calculate student's todayStats
        let todayStats = { 
            totalMinutes: 0, 
            status: 'absent',
            lastCheckIn: null,
            lastCheckOut: null
        };
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayRecords = await attendanceService.queryAttendance({ 
            studentId: targetStudentId, 
            date: today 
        }, { limit: 100 });
        
        todayStats.totalMinutes = todayRecords.results.reduce((acc, curr) => acc + (curr.duration || 0), 0);
        if (todayRecords.results.length > 0) {
            const latest = todayRecords.results[0];
            todayStats.lastCheckIn = latest.checkIn;
            todayStats.lastCheckOut = latest.checkOut;
            
            const hasActive = todayRecords.results.some(r => !r.checkOut);
            todayStats.status = hasActive ? 'inside' : 'completed';
        }

        return res.status(200).json({
            success: true,
            message: 'Attendance records fetched successfully',
            data: {
                results: formattedResults,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                totalResults: result.totalResults,
                summary: {
                    total: 1,
                    present: result.totalResults,
                    absent: result.totalResults === 0 ? 1 : 0,
                    inside: result.results.filter(r => !r.checkOut).length
                },
                todayStats
            }
        });
    }

    // Handle Admin Queries (Entire Library Attendance logs)
    const activeStudents = await Student.find({ libraryId, status: 'active' });
    
    // Manage Student-Specific Daily Codes
    const dateStr = req.query.date ? new Date(req.query.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const existingCodes = await DailyCode.find({ libraryId, date: dateStr });
    const codesMap = new Map(existingCodes.map(c => [c.studentId.toString(), c.code]));

    const newCodes = [];
    for (const student of activeStudents) {
        if (!codesMap.has(student._id.toString())) {
            // generate random 6 digit alphanumeric code
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();
            newCodes.push({
                libraryId,
                studentId: student._id,
                date: dateStr,
                code
            });
            codesMap.set(student._id.toString(), code);
        }
    }
    if (newCodes.length > 0) {
        await DailyCode.insertMany(newCodes);
    }
    
    const summaryFilter = { libraryId, ...dateFilter };
    const allAttendancesRes = await attendanceService.queryAttendance(summaryFilter, { limit: 10000 });
    const allAttendances = allAttendancesRes.results;

    // Calculate overall metrics summary
    const totalCount = activeStudents.length;
    const presentCount = allAttendances.length;
    const insideCount = allAttendances.filter(a => !a.checkOut).length;
    const punchedStudentIdsSet = new Set(allAttendances.map(a => (a.studentId?._id || a.studentId).toString()));
    const absentCount = Math.max(0, totalCount - punchedStudentIdsSet.size);

    const summary = {
        total: totalCount,
        present: presentCount,
        absent: absentCount,
        inside: insideCount
    };

    // Apply search keyword filter to active students list
    const searchText = req.query.search ? req.query.search.trim().toLowerCase() : '';
    let searchedStudents = activeStudents;
    if (searchText) {
        searchedStudents = activeStudents.filter(s => 
            (s.name && s.name.toLowerCase().includes(searchText)) ||
            (s.rollNumber && s.rollNumber.toLowerCase().includes(searchText)) ||
            (s.mobile && s.mobile.toLowerCase().includes(searchText))
        );
    }
    const searchedStudentIdsSet = new Set(searchedStudents.map(s => s._id.toString()));

    // Filter attendance records by searched students
    const punchedRecords = allAttendances.filter(a => {
        const studentIdVal = (a.studentId?._id || a.studentId).toString();
        return searchedStudentIdsSet.has(studentIdVal);
    });

    // Map punched records to top level keys
    const punchedMapped = punchedRecords.map(att => {
        const studentIdVal = (att.studentId?._id || att.studentId).toString();
        const student = activeStudents.find(s => s._id.toString() === studentIdVal);
        return {
            _id: att._id.toString(),
            name: student?.name || att.studentId?.name || 'Unknown Student',
            rollNumber: student?.rollNumber || att.studentId?.rollNumber || 'N/A',
            mobile: student?.mobile || att.studentId?.mobile || '',
            status: att.checkOut ? 'PRESENT' : 'INSIDE',
            checkIn: att.checkIn,
            checkOut: att.checkOut,
            duration: att.duration,
            profileImage: student?.profileImage || att.studentId?.profileImage,
            date: att.date,
            code: codesMap.get(studentIdVal) || 'N/A'
        };
    });

    // Construct absent list for search-matched students who didn't punch in
    const absentStudents = searchedStudents.filter(s => !punchedStudentIdsSet.has(s._id.toString()));
    const absentMapped = absentStudents.map(student => ({
        _id: `${student._id}-absent`,
        name: student.name || 'Unknown Student',
        rollNumber: student.rollNumber || 'N/A',
        mobile: student.mobile || '',
        status: 'ABSENT',
        profileImage: student.profileImage,
        checkIn: null,
        checkOut: null,
        code: codesMap.get(student._id.toString()) || 'N/A'
    }));

    // Filter by requested status pill
    const selectedFilter = req.query.status ? req.query.status.toUpperCase() : 'ALL';
    let combinedResults = [];
    if (selectedFilter === 'PRESENT') {
        combinedResults = punchedMapped.filter(r => r.status === 'PRESENT');
    } else if (selectedFilter === 'INSIDE') {
        combinedResults = punchedMapped.filter(r => r.status === 'INSIDE');
    } else if (selectedFilter === 'ABSENT') {
        combinedResults = absentMapped;
    } else {
        combinedResults = [...punchedMapped, ...absentMapped];
    }

    // Apply pagination on combined results array
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedResults = combinedResults.slice(startIndex, endIndex);
    const totalResults = combinedResults.length;
    const totalPages = Math.ceil(totalResults / limit);

    res.status(200).json({
        success: true,
        message: 'Attendance records fetched successfully',
        data: {
            results: paginatedResults,
            page,
            limit,
            totalPages,
            totalResults,
            summary
        }
    });
});

module.exports = {
    punchIn,
    punchOut,
    getAttendance
};
