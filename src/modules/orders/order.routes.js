const express = require('express');
const router = express.Router();
const orderController = require('./order.controller');
const analyticsController = require('./analytics.controller');
const Authentication = require('../../middlewares/auth.middleware');

// Vendor Analytics
router.get('/vendor-analytics', Authentication, analyticsController.getVendorAnalytics);

// Super Admin Analytics (admin only)
router.get('/super-admin-analytics', Authentication, analyticsController.getSuperAdminAnalytics);
router.get('/vendor-analytics/:id', Authentication, analyticsController.getVendorAnalyticsForAdmin);

// Vendor Order Routes
router.get('/vendor-order/orders', Authentication, orderController.getVendorOrders);
router.get('/vendor-order/orders/:id', Authentication, orderController.getVendorOrderById);
router.patch('/vendor-order/orders/:id/status', Authentication, orderController.updateVendorOrderStatus);

module.exports = router;
