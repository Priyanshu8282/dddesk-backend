const mongoose = require('mongoose');

/**
 * PageVisit — stores one document per unique fingerprint per vendor (or site-wide).
 * fingerprint = SHA-ish hash of (IP + User-Agent) computed on the frontend.
 * Using upsert so repeated visits from the same device never inflate the count.
 */
const pageVisitSchema = new mongoose.Schema(
    {
        fingerprint: { type: String, required: true, index: true },
        vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
    },
    { timestamps: true }
);

// Compound unique index: one record per (fingerprint + vendorId) pair
pageVisitSchema.index({ fingerprint: 1, vendorId: 1 }, { unique: true });

module.exports = mongoose.model('PageVisit', pageVisitSchema);
