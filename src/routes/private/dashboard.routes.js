const express = require('express');
const dashboardController = require('../../controllers/dashboard.controller');

const router = express.Router();

router.get('/admin', dashboardController.getAdminDashboard);
router.get('/superadmin', dashboardController.getSuperAdminDashboard);

// Legacy backward compatibility aliases
router.get('/', dashboardController.getAdminDashboard);

module.exports = router;
