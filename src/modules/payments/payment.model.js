const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
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
      ref: 'Plan',
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'online', 'unpaid'],
      required: true
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending'
    },
    transactionId: {
      type: String, // Razorpay Order ID or Receipt Number
      unique: true,
      sparse: true
    },
    paymentId: {
      type: String // Razorpay Payment ID
    },
    razorpayOrderId: {
      type: String, // Razorpay Order ID
      index: true
    },
    razorpaySignature: {
      type: String // Razorpay HMAC Signature (stored after verification)
    },
    paymentDate: {
      type: Date,
      default: Date.now
    },
    expiryDate: {
      type: Date
    },
    remarks: {
      type: String
    },
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    paymentType: {
      type: String,
      enum: ['new', 'renew'],
      default: 'new'
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Payment', paymentSchema);
