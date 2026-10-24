const mongoose = require('mongoose');

// A money movement: a collection (receipt), an online payment attempt, or a refund.
// Allocations tie it to the charges (Payment documents) it paid / refunded.
const txnAllocationSchema = new mongoose.Schema({
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true },
    amount: { type: Number, required: true },
    refunded: { type: Number, default: 0 },
    description: { type: String },
    dueBefore: { type: Number },
    dueAfter: { type: Number }
}, { _id: false });

const transactionSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    type: { type: String, enum: ['collection', 'refund'], default: 'collection' },
    // pending/processing = online attempt not yet confirmed
    status: { type: String, enum: ['pending', 'processing', 'success', 'failed'], default: 'success', index: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'upi', 'online', 'bank_transfer', 'other'], default: 'cash' },
    reference: { type: String },
    note: { type: String },
    paymentDate: { type: Date, default: Date.now },
    receiptNumber: { type: String },
    allocations: [txnAllocationSchema],

    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    receivedByType: { type: String, enum: ['admin', 'staff', 'superadmin', 'student', 'system'] },

    // refund
    refundOf: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentTransaction' },
    reason: { type: String },

    // Razorpay
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    razorpayRefundId: { type: String },
    // refund idempotency / gateway state
    refundRequestId: { type: String },
    // collection idempotency key (client-generated per submit): a replay returns the original receipt
    collectRequestId: { type: String },
    refundToGateway: { type: Boolean },
    gatewayUnknown: { type: Boolean, default: false }, // gateway call outcome unknown (timeout / 5xx): verify before retrying
    processingAt: { type: Date },
    failureReason: { type: String },
    needsReview: { type: Boolean, default: false },
    source: { type: String, enum: ['manual', 'verify', 'webhook'], default: 'manual' }
}, { timestamps: true });

transactionSchema.index({ libraryId: 1, receiptNumber: 1 }, { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } });
transactionSchema.index({ razorpayOrderId: 1 }, { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } });
transactionSchema.index({ razorpayPaymentId: 1, type: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
transactionSchema.index({ razorpayRefundId: 1 }, { unique: true, partialFilterExpression: { razorpayRefundId: { $type: 'string' } } });
transactionSchema.index({ libraryId: 1, refundRequestId: 1 }, { unique: true, partialFilterExpression: { refundRequestId: { $type: 'string' } } });
transactionSchema.index({ libraryId: 1, collectRequestId: 1 }, { unique: true, partialFilterExpression: { collectRequestId: { $type: 'string' } } });
transactionSchema.index({ libraryId: 1, studentId: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentTransaction', transactionSchema);
