const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const paymentController = require('./payment.controller');
const razorpayController = require('./razorpay.controller');

const router = express.Router();

router.use(Authentication);

// ── Standard Payment Routes ─────────────────────────────
router
    .route('/')
    .post(paymentController.createPayment)
    .get(paymentController.getPayments);

router
    .route('/:paymentId')
    .get(paymentController.getPayment);

// ── Razorpay Online Payment Routes ─────────────────────
// POST /private/payments/razorpay/create-order  → creates Razorpay order
// POST /private/payments/razorpay/verify-payment → verifies & activates plan
router.post('/razorpay/create-order', razorpayController.createOrder);
router.post('/razorpay/verify-payment', razorpayController.verifyPayment);

module.exports = router;
