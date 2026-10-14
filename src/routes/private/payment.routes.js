const express = require('express');
const paymentController = require('../../controllers/payment.controller');
const razorpayController = require('../../controllers/razorpay.controller');
const validate = require('../../middlewares/validate.middleware');
const { paymentValidation } = require('../../validations');

const router = express.Router();

router.get('/', paymentController.getPayments);
router.post('/', validate(paymentValidation.createPayment), paymentController.createPayment);
router.get('/:paymentId', paymentController.getPayment);
router.patch('/:paymentId/collect', validate(paymentValidation.collectPartialPayment), paymentController.collectPartialPayment);

// Razorpay Online Payments
router.post('/razorpay/create-order', validate(paymentValidation.createRazorpayOrder), razorpayController.createOrder);
router.post('/razorpay/verify-payment', validate(paymentValidation.verifyRazorpayPayment), razorpayController.verifyPayment);

module.exports = router;
