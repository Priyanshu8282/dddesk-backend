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
const complaintRoutes = require('./complaint.routes');
const couponRoutes = require('./coupon.routes');
const reviewRoutes = require('./review.routes');
const reportRoutes = require('./report.routes');
const aiRoutes = require('./ai.routes');

const router = express.Router();

// Apply Authentication middleware to all private routes
router.use(Authentication);

// Cheap "am I allowed in right now?" probe. Authentication applies the maintenance rules, so this answers 503 while this
// user is blocked and 200 once the window is over: the maintenance screen polls it to recover on its own.
router.get('/maintenance-check', (req, res) => res.json({ success: true, data: { ok: true } }));

// Auth / Profile
router.use('/', authRoutes);

// Dashboards
router.use('/dashboard', dashboardRoutes);
router.use('/superadmin/dashboard', dashboardRoutes.superRouter);

// Core Modules
router.use('/files', require('./files.routes'));
router.use('/admins', adminRoutes);
router.use('/staff', adminRoutes); // alias for frontend /staff/*
router.use('/roles', roleRoutes);
// SaaS subscription billing (mounted before /libraries so /libraries/:id cannot swallow it)
router.use('/libraries/subscription', require('./subscription.routes').owner);
router.use('/super/subscriptions', require('./subscription.routes').superAdmin);
router.use('/super/revenue', require('./revenue.routes'));
router.use('/super/users', require('./platformUser.routes'));
router.use('/super/platform-settings', require('./platformSettings.routes'));
router.use('/libraries', libraryRoutes);
router.use('/super/libraries', superLibraryRoutes);
router.use('/super/platform-plans', platformPlanRoutes);
router.use('/super/audit', auditRoutes);
// Platform support & tooling (spec 5)
router.use('/support', require('./support.routes').library);
router.use('/super/support', require('./support.routes').superAdmin);
router.use('/announcements', require('./platformAdmin.routes').active);
router.use('/super/announcements', require('./platformAdmin.routes').announcements);
router.use('/super/notification-providers', require('./platformAdmin.routes').providers);
router.use('/super/system-events', require('./platformAdmin.routes').systemEvents);
router.use('/students', studentRoutes);
router.use('/plans', planRoutes);
router.use('/payments', paymentRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/seats', seatRoutes);
router.use('/expenses', expenseRoutes);
router.use('/enquiries', enquiryRoutes);
router.use('/complaints', complaintRoutes);
router.use('/coupons', couponRoutes);
router.use('/offers', couponRoutes); // alias for offers
router.use('/reviews', reviewRoutes);
router.use('/feedback', reviewRoutes); // alias for feedback
router.use('/reports', reportRoutes);
router.use('/ai', aiRoutes);
router.use('/assistant', aiRoutes); // alias for assistant

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
