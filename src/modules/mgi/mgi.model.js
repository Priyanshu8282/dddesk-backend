const mongoose = require('mongoose');

const mgiOrderDetailSchema = new mongoose.Schema({
    productServiceCategoryCode: { type: String, required: true }, // FC, SC, TC, HC
    productServiceCategoryName: { type: String },
    psAmount: { type: Number, required: true },
    commissionAmount: { type: Number, default: 0 },
    bvPointAmount: { type: Number, default: 0 },
}, { _id: false });

const mgiOrderSchema = new mongoose.Schema({
    // Reference to our Customer
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
        required: false, // optional: customer might not be in our system
    },

    // MGI Customer Info
    mgiCustomerCode: { type: String, required: true, index: true },
    mgiCustomerMobile: { type: String },
    mgiCustomerName: { type: String },

    // MGI Order Info
    mgiOrderNo: { type: Number, index: true },      // MGI's order number (returned after AddOrder)
    billNo: { type: String, required: true, index: true },
    billDate: { type: String, required: true },
    remark: { type: String, default: 'Order Placed' },

    // Financial Summary
    totalPsAmount: { type: Number, default: 0 },
    totalCommissionAmount: { type: Number, default: 0 },
    totalBvPointAmount: { type: Number, default: 0 },

    // Order Line Items
    orderDetails: [mgiOrderDetailSchema],

    // Booking Status
    status: {
        type: String,
        enum: ['success', 'failed', 'pending'],
        default: 'success',
    },

    // Error info if booking failed
    errorCode: { type: Number },
    errorDescription: { type: String },

    // Raw MGI Response (for debugging)
    rawMgiResponse: { type: mongoose.Schema.Types.Mixed },
}, {
    timestamps: true,
});

// Useful compound index for searching by affiliate
mgiOrderSchema.index({ mgiCustomerCode: 1, createdAt: -1 });

const MgiOrder = mongoose.model('MgiOrder', mgiOrderSchema);

module.exports = MgiOrder;
