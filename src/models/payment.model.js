const mongoose = require('mongoose');

// Payment = a "Charge" document in the fee ledger (one fee/invoice for a student).
// Money received against charges is recorded in PaymentTransaction (receipts) and
// each receipt's allocation is mirrored here in `allocations` for traceability.

const allocationSchema = new mongoose.Schema({
    chargeMonth: { type: String }, // e.g. "2026-10"
    allocatedAmount: { type: Number, required: true },
    refundedAmount: { type: Number, default: 0 },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentTransaction' },
    receiptNumber: { type: String },
    method: { type: String },
    date: { type: Date, default: Date.now }
}, { _id: false });

const itemSchema = new mongoose.Schema({
    label: { type: String },
    kind: { type: String, enum: ['membership', 'joining_fee', 'deposit', 'late_fee', 'other'], default: 'other' },
    amount: { type: Number, required: true }
}, { _id: false });

const adjustmentSchema = new mongoose.Schema({
    type: { type: String },
    reason: { type: String },
    amount: { type: Number, default: 0 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    at: { type: Date, default: Date.now },
    // idempotency key of an adjust / cancel request and what it asked for: a retry finds it and changes nothing
    requestId: { type: String },
    requestSignature: { type: String }
}, { _id: false });

const TERMINAL = ['cancelled', 'refunded'];
const COMPUTED_FIELDS = ['paidAmount', 'dueAmount', 'paymentStatus', 'totalAmount', 'discountAmount', 'waivedAmount', 'lateFee', 'refundAmount'];

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
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    planId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan'
    },

    // ── Core amounts ──────────────────────────────────
    totalAmount: {
        type: Number,
        required: true,
        min: 0,
        comment: 'Gross charge amount (before discount / waiver)'
    },
    paidAmount: {
        type: Number,
        required: true,
        default: 0,
        min: 0
    },
    dueAmount: {
        type: Number,
        required: true,
        default: 0
    },
    discountAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    lateFee: {
        type: Number,
        default: 0,
        min: 0
    },
    waivedAmount: {
        type: Number,
        default: 0,
        min: 0
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
        enum: ['cash', 'upi', 'online', 'bank_transfer', 'other']
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

    // ── Receipt (legacy single receipt; per-collection receipts live in PaymentTransaction)
    receiptNumber: {
        type: String,
        unique: true,
        sparse: true
    },

    // ── Allocation ledger (which receipts paid this charge) ──
    allocations: [allocationSchema],
    items: [itemSchema],
    adjustments: [adjustmentSchema],
    description: { type: String },

    // ── Coupon ────────────────────────────────────────
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: { type: String },

    // ── Refund ────────────────────────────────────────
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String },
    refundDate: { type: Date },

    // ── Cancel ────────────────────────────────────────
    cancelledAt: { type: Date },
    cancelReason: { type: String },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // ── Reminders (fee cron) ──────────────────────────
    lastReminderAt: { type: Date },
    reminderCount: { type: Number, default: 0 },
    overdueSince: { type: Date },

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
}, { timestamps: true, optimisticConcurrency: true });

paymentSchema.index({ libraryId: 1, studentId: 1, paymentStatus: 1 });
paymentSchema.index({ libraryId: 1, paymentStatus: 1, dueDate: 1 });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Recompute dueAmount + status. Terminal statuses (cancelled / refunded) are never overwritten.
paymentSchema.pre('save', function () {
    if (this.paymentStatus === 'cancelled') {
        this.dueAmount = 0;
        return;
    }
    const gross = r2((this.totalAmount || 0) + (this.lateFee || 0));
    const net = r2(gross - (this.discountAmount || 0) - (this.waivedAmount || 0));
    this.dueAmount = Math.max(0, r2(net - (this.paidAmount || 0)));

    if (this.paymentStatus === 'refunded') {
        this.dueAmount = 0;
        return;
    }
    if ((this.refundAmount || 0) > 0 && this.paidAmount > 0 && this.refundAmount >= this.paidAmount - 0.001) {
        this.paymentStatus = 'refunded';
        this.dueAmount = 0;
        return;
    }

    const wasOverdue = this.paymentStatus === 'overdue';
    if (this.dueAmount <= 0) {
        // Nothing left to pay: paid if money was received, waived if it was forgiven entirely
        this.paymentStatus = (this.paidAmount <= 0 && (this.waivedAmount || 0) > 0) ? 'waived' : 'paid';
    } else if (this.paidAmount <= 0) {
        this.paymentStatus = wasOverdue ? 'overdue' : 'credit';
    } else {
        this.paymentStatus = wasOverdue ? 'overdue' : 'partial';
    }
    if (this.paymentStatus !== 'overdue') this.overdueSince = undefined;
});

// Guard: computed money/status fields may only change through save() so the hook always runs.
const guardUpdate = function () {
    if (this.getOptions && this.getOptions().allowComputed) return;
    const upd = this.getUpdate() || {};
    const touched = [];
    const scan = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        Object.keys(obj).forEach((k) => {
            if (COMPUTED_FIELDS.includes(k)) touched.push(k);
        });
    };
    scan(upd);
    ['$set', '$inc', '$unset', '$setOnInsert', '$min', '$max', '$mul'].forEach((op) => scan(upd[op]));
    if (touched.length) {
        throw new Error(`Payment fields [${touched.join(', ')}] must be changed via document.save() (ledger service)`);
    }
};
paymentSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], guardUpdate);

paymentSchema.statics.TERMINAL = TERMINAL;
paymentSchema.statics.OPEN_STATUSES = ['credit', 'partial', 'overdue'];

module.exports = mongoose.model('Payment', paymentSchema);
