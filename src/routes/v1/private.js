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
const router = express.Router();

const libraryRoutes = require('../../modules/libraries/library.routes');
const studentRoutes = require('../../modules/students/student.routes');
const planRoutes = require('../../modules/plans/plan.routes');
const paymentRoutes = require('../../modules/payments/payment.routes');
const attendanceRoutes = require('../../modules/attendance/attendance.routes');
const storyRoutes = require('../../modules/stories/story.routes');
const noticeRoutes = require('../../modules/notices/notice.routes');
const bannerRoutes = require('../../modules/banners/banner.routes');

router.get('/me', Authentication, authController.getMe);
router.put('/update-profile', Authentication, upload.single('profileImage'), authController.updateProfile);
router.delete('/delete-profile-image', Authentication, authController.deleteProfileImage);
router.get('/debug-routes', (req, res) => {
    const routes = router.stack.map(s => s.route ? s.route.path : s.name);
    res.json(routes);
});
// Admins (Staff)
router.use('/admins', adminRoutes);
// Roles
router.use('/roles', roleRoutes);
router.use('/libraries', libraryRoutes);
router.use('/students', studentRoutes);
router.use('/plans', planRoutes);
router.use('/payments', paymentRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/stories', storyRoutes);
router.use('/notices', noticeRoutes);
router.use('/banners', bannerRoutes);

// Admin / Library Notifications
router.get('/notifications', Authentication, notificationController.getMyNotifications);
router.patch('/notifications/read-all', Authentication, notificationController.markMyNotificationsAsRead);
router.post('/notifications/delete', Authentication, notificationController.deleteNotifications);


//testing
// Permissions
router.post('/permissions/create-permission', Authentication, permissionController.createPermission);
router.get('/permissions/get-permissions', Authentication, permissionController.getPermissions);
router.put('/permissions/update-permission/:id', Authentication, permissionController.updatePermission);
router.delete('/permissions/delete-permission/:id', Authentication, permissionController.deletePermission);

// Sidebar Menus
router.post('/sidebar/create-menu', Authentication, sidebarController.createSidebarMenu);
router.get('/sidebar/get-menus', Authentication, sidebarController.getSidebarMenus);
router.get('/sidebar/get-all-menus', Authentication, sidebarController.getAllSidebarMenus);
router.put('/sidebar/update-menu/:id', Authentication, sidebarController.updateSidebarMenu);
router.delete('/sidebar/delete-menu/:id', Authentication, sidebarController.deleteSidebarMenu);


module.exports = router;
