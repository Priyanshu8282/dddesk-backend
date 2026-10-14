const express = require('express');
const razorpayController = require('../../controllers/razorpay.controller');

const router = express.Router();

// POST /v1/public/razorpay/webhook
// Signature is verified against req.rawBody (captured by express.json({ verify }) in app.js).
router.post('/webhook', razorpayController.webhookHandler);

module.exports = router;
