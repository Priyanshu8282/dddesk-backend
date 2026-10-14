const noticeService = require('../services/notice.service');
const Notice = require('../models/notice.model');
const fs = require('fs');
const path = require('path');

// Ensure proper backend uploads folder exists for Notices
const noticesUploadDir = path.join(process.cwd(), 'uploads/notices');
if (!fs.existsSync(noticesUploadDir)) {
    try {
        fs.mkdirSync(noticesUploadDir, { recursive: true });
    } catch (err) {
        console.warn('Could not create uploads/notices directory:', err.message);
    }
}

/**
 * Create a new Notice (Admin only)
 */
exports.createNotice = async (req, res, next) => {
    try {
        const noticeData = { ...req.body };

        // Parse targeted students if present
        if (noticeData.targetStudents) {
            try {
                noticeData.targetStudents = JSON.parse(noticeData.targetStudents);
            } catch (e) {
                if (typeof noticeData.targetStudents === 'string') {
                    noticeData.targetStudents = noticeData.targetStudents.split(',').map(s => s.trim()).filter(Boolean);
                }
            }
        }

        // Handle optional file upload
        if (req.file) {
            noticeData.imageUrl = req.file.path;
        }

        // Automatic library link based on logged in Admin
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            noticeData.libraryId = req.user.libraryId;
        }

        if (!noticeData.libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const creatorInfo = req.user ? { id: req.user._id || req.user.id } : null;
        const notice = await noticeService.createNotice(noticeData, creatorInfo);

        const { notifyLibraryAdmins, notifyMultipleStudents } = require('../services/firebase.service');
        notifyLibraryAdmins(
            noticeData.libraryId,
            "📢 Notice Published Successfully",
            `${noticeData.title} was published.`
        );

        // Notify Students
        const Student = require('../models/student.model');
        let studentsToNotify = [];
        if (noticeData.sendTo === 'specific' && noticeData.targetStudents && noticeData.targetStudents.length > 0) {
            studentsToNotify = noticeData.targetStudents;
        } else if (noticeData.sendTo === 'premium') {
            const premiumStudents = await Student.find({ libraryId: noticeData.libraryId, membershipStatus: 'premium', status: 'active', isDeleted: false });
            studentsToNotify = premiumStudents.map(s => s._id);
        } else {
            const allStudents = await Student.find({ libraryId: noticeData.libraryId, status: 'active', isDeleted: false });
            studentsToNotify = allStudents.map(s => s._id);
        }

        if (studentsToNotify.length > 0) {
            await notifyMultipleStudents(
                studentsToNotify,
                "📢 New Notice",
                noticeData.title,
                { noticeId: notice._id.toString() },
                'notice_alert'
            );
        }

        res.status(201).json({
            success: true,
            message: 'Notice created successfully',
            data: notice
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get notices list with dynamic dashboard analytics (Admin only)
 */
exports.getNotices = async (req, res, next) => {
    try {
        const libraryId = req.user?.libraryId || req.query.libraryId;
        if (!libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const { search = "", status = "all", page = 1, limit = 10 } = req.query;
        const filter = { libraryId };

        // Search text criteria
        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        // Status pill filtering
        if (status === 'active') {
            filter.isActive = true;
        } else if (status === 'inactive') {
            filter.isActive = false;
        }

        const result = await noticeService.queryNotices(filter, { page, limit });

        // Calculate dynamic dashboard insights
        const total = await Notice.countDocuments({ libraryId });
        const active = await Notice.countDocuments({ libraryId, isActive: true });
        const expired = await Notice.countDocuments({ libraryId, isActive: false });
        
        const allNotices = await Notice.find({ libraryId });
        const totalViews = allNotices.reduce((sum, n) => sum + (n.views || 0), 0);

        const summary = {
            total,
            active,
            expired,
            totalViews
        };

        res.status(200).json({
            success: true,
            message: 'Notices retrieved successfully',
            data: result.results,
            results: result.results,
            page: result.page,
            limit: result.limit,
            totalResults: result.totalResults,
            summary
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get active notices for Student Dashboard
 */
exports.getNoticesForStudent = async (req, res, next) => {
    try {
        const libraryId = req.user?.libraryId || req.query.libraryId;
        if (!libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const studentId = req.user?._id;
        const isPremium = req.user?.membershipStatus === 'premium'; // Check student membership

        const notices = await noticeService.getActiveStudentNotices(libraryId, studentId, isPremium);
        res.status(200).json({
            success: true,
            message: 'Student notices retrieved successfully',
            data: notices
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Increment unique view count for a student
 */
exports.markNoticeViewed = async (req, res, next) => {
    try {
        const studentId = req.user?._id;
        const notice = await noticeService.incrementViews(req.params.id, studentId);
        res.status(200).json({
            success: true,
            message: 'Notice marked as viewed',
            data: notice
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Toggle Notice active/inactive status
 */
exports.toggleNoticeActive = async (req, res, next) => {
    try {
        const notice = await noticeService.getNoticeById(req.params.id);
        if (!notice) {
            return res.status(404).json({ success: false, message: 'Notice not found' });
        }

        notice.isActive = !notice.isActive;
        await notice.save();

        res.status(200).json({
            success: true,
            message: `Notice status updated to ${notice.isActive ? 'Active' : 'Inactive'}`,
            data: notice
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a notice
 */
exports.deleteNotice = async (req, res, next) => {
    try {
        await noticeService.deleteNotice(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Notice deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update notice (Admin only)
 */
exports.updateNotice = async (req, res, next) => {
    try {
        const noticeData = { ...req.body };

        // Parse targeted students if present
        if (noticeData.targetStudents) {
            try {
                noticeData.targetStudents = JSON.parse(noticeData.targetStudents);
            } catch (e) {
                if (typeof noticeData.targetStudents === 'string') {
                    noticeData.targetStudents = noticeData.targetStudents.split(',').map(s => s.trim()).filter(Boolean);
                }
            }
        }

        // Handle optional file upload
        if (req.file) {
            noticeData.imageUrl = req.file.path;
        }

        const notice = await noticeService.updateNotice(req.params.id, noticeData);
        if (!notice) {
            return res.status(404).json({ success: false, message: 'Notice not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Notice updated successfully',
            data: notice
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get Notice by ID (Admin only)
 */
exports.getNoticeById = async (req, res, next) => {
    try {
        const notice = await noticeService.getNoticeById(req.params.id);
        if (!notice) {
            return res.status(404).json({ success: false, message: 'Notice not found' });
        }
        res.status(200).json({
            success: true,
            message: 'Notice retrieved successfully',
            data: notice
        });
    } catch (error) {
        next(error);
    }
};
