const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');
const authController = require('../../modules/auth/auth.controller');
const roleRoutes = require('../../modules/roles/role.routes');
const adminRoutes = require('../../modules/admins/admin.routes');
const permissionController = require('../../modules/permissions/permission.controller');
const sidebarController = require('../../modules/sidebar/sidebar.controller');
const notificationController = require('../../modules/notifications/notification.controller');
const upload = require('../../middlewares/upload.middleware');
const dashboardController = require('../../modules/dashboard/dashboard.controller');

const libraryRoutes = require('../../modules/libraries/library.routes');
const superLibraryRoutes = require('../../modules/libraries/superLibrary.routes');
const studentRoutes = require('../../modules/students/student.routes');
const planRoutes = require('../../modules/plans/plan.routes');
const paymentRoutes = require('../../modules/payments/payment.routes');
const attendanceRoutes = require('../../modules/attendance/attendance.routes');
const storyRoutes = require('../../modules/stories/story.routes');
const noticeRoutes = require('../../modules/notices/notice.routes');
const bannerRoutes = require('../../modules/banners/banner.routes');
const seatRoutes = require('../../modules/seats/seat.routes');
const expenseRoutes = require('../../modules/expenses/expense.routes');
const enquiryRoutes = require('../../modules/enquiries/enquiry.routes');
const auditRoutes = require('../../modules/audit/auditLog.routes');
const platformPlanRoutes = require('../../modules/platformPlans/platformPlan.routes');
const settingRoutes = require('../../modules/settings/setting.routes');
const websiteRoutes  = require('../../modules/website/libraryWebsite.routes');
const branchRoutes   = require('../../modules/branches/branch.routes');

const router = express.Router();

// ── Auth / Profile ────────────────────────────────
router.get('/me', Authentication, authController.getMe);
router.put('/update-profile', Authentication, upload.single('profileImage'), authController.updateProfile);
router.delete('/delete-profile-image', Authentication, authController.deleteProfileImage);

// ── Dashboard ─────────────────────────────────────
router.get('/dashboard/admin', Authentication, dashboardController.getAdminDashboard);
router.get('/dashboard/superadmin', Authentication, dashboardController.getSuperAdminDashboard);
// Keep legacy paths for backward compatibility
router.get('/dashboard', Authentication, dashboardController.getAdminDashboard);
router.get('/superadmin/dashboard', Authentication, dashboardController.getSuperAdminDashboard);

// ── Core library modules ──────────────────────────
router.use('/admins', adminRoutes);
router.use('/staff', adminRoutes);     // alias – frontend uses /staff/*
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

// ── Content modules ───────────────────────────────
router.use('/stories', storyRoutes);
router.use('/notices', noticeRoutes);
router.use('/banners', bannerRoutes);

// ── Notifications ─────────────────────────────────
router.get('/notifications', Authentication, notificationController.getMyNotifications);
router.patch('/notifications/read-all', Authentication, notificationController.markMyNotificationsAsRead);
router.post('/notifications/delete', Authentication, notificationController.deleteNotifications);

// ── Permissions ───────────────────────────────────
router.post('/permissions/create-permission', Authentication, permissionController.createPermission);
router.get('/permissions/get-permissions', Authentication, permissionController.getPermissions);
router.put('/permissions/update-permission/:id', Authentication, permissionController.updatePermission);
router.delete('/permissions/delete-permission/:id', Authentication, permissionController.deletePermission);

// ── Settings (global key-value store) ─────────────
router.use('/settings', settingRoutes);

// ── Library Website / Public Profile ──────────────
router.use('/website', websiteRoutes);

// ── Multi-Branch Management ───────────────────────
router.use('/branches', branchRoutes);

// ── Sidebar Menus ─────────────────────────────────
router.post('/sidebar/create-menu', Authentication, sidebarController.createSidebarMenu);
router.get('/sidebar/get-menus', Authentication, sidebarController.getSidebarMenus);
router.get('/sidebar/get-all-menus', Authentication, sidebarController.getAllSidebarMenus);
router.put('/sidebar/update-menu/:id', Authentication, sidebarController.updateSidebarMenu);
router.delete('/sidebar/delete-menu/:id', Authentication, sidebarController.deleteSidebarMenu);

module.exports = router;
