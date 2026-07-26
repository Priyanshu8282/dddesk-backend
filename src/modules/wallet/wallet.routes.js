const express = require('express');
const router = express.Router();
const walletController = require('./wallet.controller');

router.get('/balance', walletController.getWalletBalance);
router.post('/recharge', walletController.createRechargeOrder);
router.post('/verify-payment', walletController.verifyRechargePayment);
router.get('/transactions', walletController.getTransactions);

module.exports = router;
