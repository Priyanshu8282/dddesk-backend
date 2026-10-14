const mongoose = require('mongoose');

// Atomic per-library receipt sequence
const receiptCounterSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, unique: true },
    seq: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('ReceiptCounter', receiptCounterSchema);
