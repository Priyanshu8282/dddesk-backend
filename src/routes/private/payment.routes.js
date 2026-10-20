const express = require('express');
const paymentController = require('../../controllers/payment.controller');
const razorpayController = require('../../controllers/razorpay.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission, allow } = require('../../middlewares/access.middleware');
const { paymentValidation } = require('../../validations');

const router = express.Router();

// Students pay their own dues; staff need collection rights to start/verify an online payment for a student
const anyPayer = [allow('student', 'admin', 'staff', 'superadmin'), (req, res, next) => (req.userType === 'student' ? next() : requirePermission('fees.collect')(req, res, next))];
const REFUND = ['fees.refund', 'FEES_REFUND', 'REFUND_PAYMENT'];
const ADJUST = ['fees.adjust', 'fees.refund', 'FEES_ADJUST', 'ADJUST_PAYMENT'];
const VIEW = ['fees.view', 'fees.collect', 'fees.refund'];  // financial visibility (spec 12)
const COLLECT = ['fees.collect'];

// ── Student-facing (own data only) ────────────────────────────────────────────
router.get('/my', requireStudent, paymentController.getMyLedger);
router.get('/my/receipts/:paymentId', requireStudent, validate(paymentValidation.idOnly), paymentController.getMyReceipt);

// ── Razorpay online payments (student pays own dues; staff on behalf of a student) ──
router.post('/razorpay/create-order', ...anyPayer, validate(paymentValidation.createRazorpayOrder), razorpayController.createOrder);
router.post('/razorpay/verify', ...anyPayer, validate(paymentValidation.verifyRazorpayPayment), razorpayController.verifyPayment);
router.post('/razorpay/verify-payment', ...anyPayer, validate(paymentValidation.verifyRazorpayPayment), razorpayController.verifyPayment);

// ── Staff ─────────────────────────────────────────────────────────────────────
router.get('/summary', requireStaff, requirePermission(...VIEW), paymentController.getSummary);
router.get('/export', requireStaff, requirePermission(...VIEW), validate(paymentValidation.queryPayments), paymentController.exportPayments);
router.get('/outstanding', requireStaff, requirePermission(...VIEW), validate(paymentValidation.queryDues), paymentController.getOutstanding);
router.get('/overdue', requireStaff, requirePermission(...VIEW), validate(paymentValidation.queryDues), paymentController.getOverdue);
router.get('/student/:studentId/ledger', requireStaff, requirePermission(...VIEW), paymentController.getStudentLedger);

router.get('/', requireStaff, requirePermission(...VIEW), validate(paymentValidation.queryPayments), paymentController.getPayments);
router.post('/', requireStaff, requirePermission(...COLLECT), validate(paymentValidation.createPayment), paymentController.createPayment);
router.get('/:paymentId', requireStaff, requirePermission(...VIEW), validate(paymentValidation.idOnly), paymentController.getPayment);
router.get('/:paymentId/receipt', requireStaff, requirePermission(...VIEW), validate(paymentValidation.idOnly), paymentController.getReceipt);
router.patch('/:paymentId/collect', requireStaff, requirePermission(...COLLECT), validate(paymentValidation.collectPartialPayment), paymentController.collectPartialPayment);
router.post('/:paymentId/refund', requireStaff, requirePermission(...REFUND), validate(paymentValidation.refundPayment), paymentController.refundPayment);
router.post('/:paymentId/adjust', requireStaff, requirePermission(...ADJUST), validate(paymentValidation.adjustPayment), paymentController.adjustPayment);
router.post('/:paymentId/cancel', requireStaff, requirePermission(...ADJUST), validate(paymentValidation.cancelPayment), paymentController.cancelPayment);

module.exports = router;
