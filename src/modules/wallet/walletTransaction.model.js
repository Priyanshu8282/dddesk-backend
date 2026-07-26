const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    transactionType: { type: String, enum: ['credit', 'debit', 'refund'], required: true },
    transactionFor: { type: String, enum: ['wallet_recharge', 'order_payment', 'order_refund'], required: true },
    amount: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    referenceId: { type: String }, // e.g., Order ID or Razorpay Payment ID
    paymentMethod: { type: String, enum: ['razorpay', 'wallet'], required: true },
    paymentStatus: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
    description: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
