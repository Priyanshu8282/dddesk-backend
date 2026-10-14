const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');

// Sub-route modules
const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const adminRoutes = require('./admin.routes');
const roleRoutes = require('./role.routes');
const libraryRoutes = require('./library.routes');
const superLibraryRoutes = require('./superLibrary.routes');
const platformPlanRoutes = require('./platformPlan.routes');
const auditRoutes = require('./audit.routes');
const studentRoutes = require('./student.routes');
const planRoutes = require('./plan.routes');
const paymentRoutes = require('./payment.routes');
const attendanceRoutes = require('./attendance.routes');
const seatRoutes = require('./seat.routes');
const expenseRoutes = require('./expense.routes');
const enquiryRoutes = require('./enquiry.routes');
const storyRoutes = require('./story.routes');
const noticeRoutes = require('./notice.routes');
const bannerRoutes = require('./banner.routes');
const notificationRoutes = require('./notification.routes');
const permissionRoutes = require('./permission.routes');
const settingRoutes = require('./setting.routes');
const websiteRoutes = require('./website.routes');
const branchRoutes = require('./branch.routes');
const sidebarRoutes = require('./sidebar.routes');

const router = express.Router();

// Apply Authentication middleware to all private routes
router.use(Authentication);

// Auth / Profile
router.use('/', authRoutes);

// Dashboards
router.use('/dashboard', dashboardRoutes);
router.use('/superadmin/dashboard', dashboardRoutes);

// Core Modules
router.use('/admins', adminRoutes);
router.use('/staff', adminRoutes); // alias for frontend /staff/*
router.use('/roles', roleRoutes);
router.use('/libraries', libraryRoutes);
router.use('/super/libraries', superLibraryRoutes);
router.use('/super/platform-plans', platformPlanRoutes);
router.use('/super/audit', auditRoutes);
router.use('/students', studentRoutes);
router.use('/plans', planRoutes);
router.use('/payments', paymentRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/seats', seatRoutes);
router.use('/expenses', expenseRoutes);
router.use('/enquiries', enquiryRoutes);

// Content Modules
router.use('/stories', storyRoutes);
router.use('/notices', noticeRoutes);
router.use('/banners', bannerRoutes);

// Communication & Management
router.use('/notifications', notificationRoutes);
router.use('/permissions', permissionRoutes);
router.use('/settings', settingRoutes);
router.use('/website', websiteRoutes);
router.use('/branches', branchRoutes);
router.use('/sidebar', sidebarRoutes);

module.exports = router;
