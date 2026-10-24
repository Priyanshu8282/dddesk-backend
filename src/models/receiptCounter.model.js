const mongoose = require('mongoose');

// Atomic per-library receipt sequence
const receiptCounterSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, unique: true },
    // Legacy single sequence (receipts issued before financial-year numbering)
    seq: { type: Number, default: 0 },
    // Per financial-year sequence (Apr-Mar IST), key "2627" -> last number used in that year
    fySeq: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('ReceiptCounter', receiptCounterSchema);
