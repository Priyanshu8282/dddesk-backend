/**
 * mgi.routes.js
 *
 * Routes for the MGI Affiliate API integration.
 * All routes are protected by customerAuth middleware (added in private.js).
 */

const express = require('express');
const router = express.Router();
const mgiController = require('./mgi.controller');

// ─── Customer Validation ──────────────────────────────────────────────────────
// POST /v1/private/website/mgi/validate-customer
router.post('/validate-customer', mgiController.validateCustomer);

// ─── Categories ───────────────────────────────────────────────────────────────
// GET /v1/private/website/mgi/categories
router.get('/categories', mgiController.getCategories);

// ─── Add Order ────────────────────────────────────────────────────────────────
// POST /v1/private/website/mgi/add-order
router.post('/add-order', mgiController.addOrder);

// ─── Order History (from MGI server) ─────────────────────────────────────────
// GET /v1/private/website/mgi/order-history
// Query: orderNo, customerCode, billNo, orderFromDate, orderToDate, billFromDate, billToDate
router.get('/order-history', mgiController.getOrderHistory);

// ─── My Local Orders (from MongoDB — faster) ─────────────────────────────────
// GET /v1/private/website/mgi/my-orders
// Query: page, limit
router.get('/my-orders', mgiController.getMyLocalOrders);

// ─── Ledger ───────────────────────────────────────────────────────────────────
// GET /v1/private/website/mgi/ledger
// Query: fromDate (required), toDate (required)
router.get('/ledger', mgiController.getLedger);

module.exports = router;
