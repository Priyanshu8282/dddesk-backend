const express = require('express');
const dashboardController = require('../../controllers/dashboard.controller');
const { requireStaff, requireSuperAdmin } = require('../../middlewares/access.middleware');

const router = express.Router();

// Library dashboard (owner / staff; superadmin with ?libraryId=)
router.get('/admin', requireStaff, dashboardController.getAdminDashboard);
// Platform dashboard
router.get('/superadmin', requireSuperAdmin, dashboardController.getSuperAdminDashboard);

// Role-based summaries + realtime hints (superadmin: platform; owner/staff: library). Students are rejected by requireStaff.
router.get('/summary', requireStaff, dashboardController.getSummary);
router.get('/charts', requireStaff, dashboardController.getCharts);
router.get('/realtime-info', requireStaff, dashboardController.getRealtimeInfo);

// Legacy alias: /dashboard -> library dashboard
router.get('/', requireStaff, dashboardController.getAdminDashboard);

// Separate router for /superadmin/dashboard so its root serves platform data
const superRouter = express.Router();
superRouter.get('/', requireSuperAdmin, dashboardController.getSuperAdminDashboard);
superRouter.get('/superadmin', requireSuperAdmin, dashboardController.getSuperAdminDashboard);
router.superRouter = superRouter;

module.exports = router;
