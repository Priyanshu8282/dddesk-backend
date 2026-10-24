const mongoose = require('mongoose');

// SaaS subscription payment made by a library owner to the platform (spec 29)
const platformPaymentSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    platformPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan', required: true },
    period: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    amount: { type: Number, required: true, min: 0 },   // TOTAL charged, including GST
    taxableAmount: { type: Number, min: 0 },            // price after credit, before GST
    gstPercent: { type: Number, min: 0 },
    gstAmount: { type: Number, min: 0 },
    // renewal | upgrade (immediate plan change, new period starts at payment, prorated credit applied)
    kind: { type: String, enum: ['renewal', 'upgrade'], default: 'renewal' },
    listPrice: { type: Number, min: 0 },        // full price of the period (amount + creditApplied)
    creditApplied: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    invoiceNo: { type: String },
    failureReason: { type: String },
    // grace handling: after a failure the library keeps access until graceUntil
    inGrace: { type: Boolean, default: false },
    graceUntil: { type: Date },
    paidAt: { type: Date },
    // Money is captured but the library was not (fully) updated yet: set when the payment is claimed, cleared once
    // the library extension has been applied. A retry / the cron picks up records that still carry the marker.
    applyPending: { type: Boolean, default: undefined },
    // Gateway captured money that does not match the order: needs a human look
    needsReview: { type: Boolean, default: undefined },
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

platformPaymentSchema.index({ razorpayOrderId: 1 }, { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } });
platformPaymentSchema.index({ invoiceNo: 1 }, { unique: true, partialFilterExpression: { invoiceNo: { $type: 'string' } } });

module.exports = mongoose.model('PlatformPayment', platformPaymentSchema);
