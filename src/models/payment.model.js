const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema({
    chargeMonth: { type: String }, // e.g. "2026-10"
    allocatedAmount: { type: Number, required: true }
}, { _id: false });

const paymentSchema = new mongoose.Schema({
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    planId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan'
    },

    // ── Core amounts ──────────────────────────────────
    totalAmount: {
        type: Number,
        required: true,
        comment: 'Full plan price / charge amount'
    },
    paidAmount: {
        type: Number,
        required: true,
        default: 0
    },
    dueAmount: {
        type: Number,
        required: true,
        default: 0
    },
    discountAmount: {
        type: Number,
        default: 0
    },
    lateFee: {
        type: Number,
        default: 0
    },
    waivedAmount: {
        type: Number,
        default: 0
    },

    // ── Payment state ─────────────────────────────────
    paymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'credit', 'overdue', 'waived', 'refunded', 'cancelled'],
        default: 'credit',
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'upi', 'online', 'bank_transfer', 'other'],
        default: 'cash'
    },

    // ── Dates ─────────────────────────────────────────
    dueDate: {
        type: Date
    },
    paymentDate: {
        type: Date
    },
    periodStart: {
        type: Date
    },
    periodEnd: {
        type: Date
    },

    // ── Razorpay (online payments) ────────────────────
    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },

    // ── Receipt ───────────────────────────────────────
    receiptNumber: {
        type: String,
        unique: true,
        sparse: true
    },

    // ── Allocation ledger (which months this payment covers) ──
    allocations: [allocationSchema],

    // ── Refund ────────────────────────────────────────
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String },
    refundDate: { type: Date },

    remarks: { type: String },
    paymentType: {
        type: String,
        enum: ['new', 'renewal', 'partial', 'advance'],
        default: 'new'
    },

    collectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    }
}, { timestamps: true });

// Auto-compute dueAmount and status before save
paymentSchema.pre('save', function () {
    this.dueAmount = Math.max(0, this.totalAmount - this.paidAmount - this.discountAmount - this.waivedAmount);

    if (this.paidAmount <= 0) {
        this.paymentStatus = this.dueDate && new Date() > this.dueDate ? 'overdue' : 'credit';
    } else if (this.dueAmount <= 0) {
        this.paymentStatus = 'paid';
    } else {
        this.paymentStatus = this.dueDate && new Date() > this.dueDate ? 'overdue' : 'partial';
    }
});

module.exports = mongoose.model('Payment', paymentSchema);
