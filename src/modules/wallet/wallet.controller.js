const Wallet = require('./wallet.model');
const WalletTransaction = require('./walletTransaction.model');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_SLWE0S1jEZmoga',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'lwwf9lUvG4AVfSpgprKZozKg',
});

exports.createWalletIfNeeded = async (customerId) => {
    let wallet = await Wallet.findOne({ customerId });
    if (!wallet) {
        wallet = await Wallet.create({ customerId, balance: 0, status: 'active' });
    }
    return wallet;
};

exports.getWalletBalance = async (req, res) => {
    try {
        const wallet = await exports.createWalletIfNeeded(req.customer._id);
        res.json({ success: true, balance: wallet.balance, currency: wallet.currency, status: wallet.status });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.createRechargeOrder = async (req, res) => {
    try {
        const { amount } = req.body; // Amount in rupees
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(amount * 100), // Convert to paise
            currency: 'INR',
            receipt: `recharge_${Date.now()}`,
            notes: {
                customerId: req.customer._id.toString(),
                purpose: 'wallet_recharge'
            }
        });

        res.json({
            success: true,
            razorpayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_SLWE0S1jEZmoga',
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.verifyRechargePayment = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, amount } = req.body; // amount is in rupees

        const keySecret = process.env.RAZORPAY_KEY_SECRET || 'lwwf9lUvG4AVfSpgprKZozKg';
        const body = `${razorpayOrderId}|${razorpayPaymentId}`;
        const expectedSignature = crypto.createHmac('sha256', keySecret).update(body).digest('hex');

        if (expectedSignature !== razorpaySignature) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: 'Invalid payment signature' });
        }

        // Use findOneAndUpdate for atomic increment, but we need balanceBefore and balanceAfter.
        // Instead, find the wallet and lock it or use standard update.
        let wallet = await Wallet.findOne({ customerId: req.customer._id }).session(session);
        if (!wallet) {
            wallet = await Wallet.create([{ customerId: req.customer._id, balance: 0, status: 'active' }], { session });
            wallet = wallet[0];
        }

        // Check if transaction already exists (idempotency)
        const existingTx = await WalletTransaction.findOne({ referenceId: razorpayPaymentId }).session(session);
        if (existingTx) {
            await session.abortTransaction();
            session.endSession();
            return res.json({ success: true, message: 'Payment already verified', balance: wallet.balance });
        }

        const balanceBefore = wallet.balance;
        wallet.balance += Number(amount);
        await wallet.save({ session });

        await WalletTransaction.create([{
            customerId: req.customer._id,
            walletId: wallet._id,
            transactionType: 'credit',
            transactionFor: 'wallet_recharge',
            amount: Number(amount),
            balanceBefore: balanceBefore,
            balanceAfter: wallet.balance,
            referenceId: razorpayPaymentId,
            paymentMethod: 'razorpay',
            paymentStatus: 'success',
            description: 'Wallet Recharge',
        }], { session });

        await session.commitTransaction();
        session.endSession();

        res.json({ success: true, message: 'Wallet recharged successfully', balance: wallet.balance });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getTransactions = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const transactions = await WalletTransaction.find({ customerId: req.customer._id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit));

        const total = await WalletTransaction.countDocuments({ customerId: req.customer._id });

        res.json({
            success: true,
            transactions,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
