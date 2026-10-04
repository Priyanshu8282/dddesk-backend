const studentService = require("./student.service");
const Student = require("./student.model");

// Create a new student
exports.createStudent = async (req, res, next) => {
    try {
        const creatorInfo = req.user ? { id: req.user.id } : null;
        const studentData = { ...req.body };

        // If logged in as Admin, automatically set the libraryId from their profile link
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            studentData.libraryId = req.user.libraryId;
        }

        // Enforce subscription maxStudents limit
        if (studentData.libraryId) {
            const Library = require('../libraries/library.model');
            const library = await Library.findById(studentData.libraryId).select('planLimits name');
            if (library) {
                const maxStudents = library.planLimits?.maxStudents ?? 100;
                const currentCount = await Student.countDocuments({ libraryId: studentData.libraryId, isDeleted: false });
                if (currentCount >= maxStudents) {
                    return res.status(403).json({
                        success: false,
                        message: `Student limit reached (${maxStudents}). Upgrade your subscription plan to add more students.`
                    });
                }
            }
        }

        // Handle file uploads (profile image)
        if (req.files && req.files.profileImage) {
            studentData.profileImage = req.files.profileImage[0].path;
        }

        // Handle multiple Aadhaar card images (front & back)
        if (req.files && req.files.aadhaarCardImage) {
            studentData.aadhaarCardImage = req.files.aadhaarCardImage.map(file => file.path);
        }

        const student = await studentService.registerStudent(studentData, creatorInfo);

        res.status(201).json({
            success: true,
            message: "Student registered successfully",
            data: student
        });
    } catch (error) {
        next(error);
    }
};

// Student Login
exports.loginStudent = async (req, res, next) => {
    console.log("[BACKEND] loginStudent request received:", req.body);
    try {
        const { mobile, email, password } = req.body;
        const identifier = mobile || email;
        const result = await studentService.loginStudent(identifier, password);

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

// Verify Student OTP
exports.verifyStudentOTP = async (req, res, next) => {
    try {
        const { mobile, otp } = req.body;
        const result = await studentService.verifyStudentOTP(mobile, otp);

        res.status(200).json({
            success: true,
            message: "Login successful",
            ...result
        });
    } catch (error) {
        next(error);
    }
};

// Resend Student OTP
exports.resendStudentOTP = async (req, res, next) => {
    try {
        const { mobile } = req.body;
        const result = await studentService.resendStudentOTP(mobile);

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

// Get all students
exports.getAllStudents = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, search = "", status = "", libraryId = "" } = req.query;

        const filter = { isDeleted: false };
        
        if (status) {
            const statusLower = status.toLowerCase();
            if (['active', 'inactive'].includes(statusLower)) {
                filter.status = statusLower;
            }
        }
        
        // Filter by library if user is a Admin or if libraryId is provided
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            filter.libraryId = req.user.libraryId;
        } else if (libraryId) {
            filter.libraryId = libraryId;
        }

        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: "i" } },
                { mobile: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        const result = await studentService.queryStudents(filter, { page, limit });

        // Calculate dynamic summary metrics for students linked to the same library
        const summaryFilter = { isDeleted: false };
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            summaryFilter.libraryId = req.user.libraryId;
        } else if (libraryId) {
            summaryFilter.libraryId = libraryId;
        }

        const totalCount = await Student.countDocuments(summaryFilter);
        const activeCount = await Student.countDocuments({ ...summaryFilter, status: 'active' });
        const inactiveCount = await Student.countDocuments({ ...summaryFilter, status: 'inactive' });

        const summary = {
            total: totalCount,
            active: activeCount,
            inactive: inactiveCount
        };

        res.status(200).json({
            success: true,
            ...result,
            summary
        });
    } catch (error) {
        next(error);
    }
};

// Get single student
exports.getStudentById = async (req, res, next) => {
    try {
        const student = await studentService.getStudentById(req.params.id);
        res.status(200).json({
            success: true,
            data: student
        });
    } catch (error) {
        next(error);
    }
};

// Update student
exports.updateStudent = async (req, res, next) => {
    try {
        const updateData = { ...req.body };
        console.log("Update Student Body:", updateData);

        if (req.files && req.files.profileImage) {
            updateData.profileImage = req.files.profileImage[0].path;
        }

        if (req.files && req.files.aadhaarCardImage) {
            updateData.aadhaarCardImage = req.files.aadhaarCardImage.map(file => file.path);
        }

        if (updateData.profileImage === 'null' || updateData.profileImage === '') {
            updateData.profileImage = null;
        }

        const student = await studentService.updateStudentById(req.params.id, updateData);
        res.status(200).json({
            success: true,
            message: "Student updated successfully",
            data: student
        });
    } catch (error) {
        next(error);
    }
};

// Soft delete student
exports.deleteStudent = async (req, res, next) => {
    try {
        await studentService.deleteStudentById(req.params.id);
        res.status(200).json({
            success: true,
            message: "Student deleted successfully"
        });
    } catch (error) {
        next(error);
    }
};

// Assign plan to student
exports.assignPlan = async (req, res, next) => {
    try {
        console.log("studentService functions:", Object.keys(studentService));
        const creatorInfo = { id: req.user.id };
        const student = await studentService.assignPlan(req.params.id, req.body, creatorInfo);
        res.status(200).json({
            success: true,
            message: "Plan assigned successfully",
            data: student
        });
    } catch (error) {
        next(error);
    }
};

// Mark plan as paid
exports.markAsPaid = async (req, res, next) => {
    try {
        const creatorInfo = { id: req.user.id };
        const student = await studentService.markAsPaid(req.params.id, req.body, creatorInfo);
        res.status(200).json({
            success: true,
            message: "Plan activated successfully",
            data: student
        });
    } catch (error) {
        next(error);
    }
};
// Get payment history for student
exports.getPaymentHistory = async (req, res, next) => {
    try {
        const payments = await studentService.getStudentPayments(req.params.id);
        res.status(200).json({
            success: true,
            message: "Payment history fetched successfully",
            data: payments
        });
    } catch (error) {
        next(error);
    }
};

// Change Password
exports.changePassword = async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const studentId = req.user.id;

        const result = await studentService.changeStudentPassword(studentId, currentPassword, newPassword);
        
        res.status(200).json({
            success: true,
            message: "Password changed successfully"
        });
    } catch (error) {
        next(error);
    }
};

// Get Dashboard Data
exports.getDashboard = async (req, res, next) => {
    try {
        const studentId = req.user.id;
        const student = await Student.findById(studentId).populate('planId');
        
        if (!student) {
            return res.status(404).json({ success: false, message: "Student not found" });
        }

        const Attendance = require('../attendance/attendance.model');

        // Calculate Present Percentage
        const totalPunches = await Attendance.countDocuments({ studentId: studentId, status: 'present' });
        
        let presentPercentage = 0;
        const startDate = student.planStartDate || student.joiningDate || new Date();
        const now = new Date();
        const diffTime = Math.abs(now - startDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1; // at least 1 day to prevent division by zero
        
        if (totalPunches > 0) {
            presentPercentage = Math.round((totalPunches / diffDays) * 100);
            if (presentPercentage > 100) presentPercentage = 100;
        }

        const metrics = {
            presentPercentage: presentPercentage,
            presentDays: totalPunches,
            absentDays: Math.max(0, diffDays - totalPunches),
            totalDays: diffDays,
            feesDue: student.planStatus === 'pending' && student.planId ? student.planId.price : 0,
        };

        const Notice = require('../notices/notice.model');
        const notices = await Notice.find({ 
            libraryId: student.libraryId,
            isActive: true 
        }).sort({ createdAt: -1 }).limit(3);

        const Banner = require('../banners/banner.model');
        const nowTime = new Date();
        const banners = await Banner.find({
            libraryId: student.libraryId,
            isActive: true,
            startDate: { $lte: nowTime },
            endDate: { $gte: nowTime }
        }).sort({ startDate: -1 });

        const storyService = require('../stories/story.service');
        const stories = await storyService.getActiveStudentStories(student.libraryId);

        const studentService = require('./student.service');
        let recentPayments = [];
        try {
            recentPayments = await studentService.getStudentPayments(studentId);
            recentPayments = recentPayments.slice(0, 3); // Get top 3
        } catch (e) {
            console.error("Error fetching payments:", e);
        }

        res.status(200).json({
            success: true,
            data: {
                metrics,
                notices,
                stories,
                banners,
                recentPayments
            }
        });
    } catch (error) {
        next(error);
    }
};
