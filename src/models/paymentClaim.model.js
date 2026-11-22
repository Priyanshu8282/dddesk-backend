const mongoose = require('mongoose');

// A student's claim that they paid the owner's UPI QR code directly (outside any gateway). This is a
// REQUEST, not a ledger entry: nothing in Payment/PaymentTransaction changes until an owner/staff member
// approves it (see services/paymentClaim.service.js), which then records a real payment the normal way.
const paymentClaimSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    // The due the student believes they are paying, if they picked one; informational only - approval
    // auto-allocates against whatever is actually open, exactly like any other recorded payment.
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },

    amount: { type: Number, required: true, min: 0.01 },
    transactionId: { type: String, required: true, trim: true, maxlength: 100 },
    note: { type: String, trim: true, maxlength: 300 },

    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    submittedAt: { type: Date, default: Date.now },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewedAt: { type: Date },
    rejectReason: { type: String, trim: true, maxlength: 300 },

    // Set once approval has actually recorded a payment, so a retried/duplicate approve call is a no-op
    // rather than a second receipt - mirrors feeLedger.service.js's own collectRequestId replay pattern.
    resultTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentTransaction' },
    resultReceiptNumber: { type: String },
}, { timestamps: true });

paymentClaimSchema.index({ libraryId: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model('PaymentClaim', paymentClaimSchema);
