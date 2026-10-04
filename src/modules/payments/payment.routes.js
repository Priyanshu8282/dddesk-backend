const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const paymentController = require('./payment.controller');
const razorpayController = require('./razorpay.controller');

const router = express.Router();
router.use(Authentication);

router.get('/', paymentController.getPayments);
router.post('/', paymentController.createPayment);
router.get('/:paymentId', paymentController.getPayment);
router.patch('/:paymentId/collect', paymentController.collectPartialPayment);

// Razorpay
router.post('/razorpay/create-order', razorpayController.createOrder);
router.post('/razorpay/verify-payment', razorpayController.verifyPayment);

module.exports = router;
