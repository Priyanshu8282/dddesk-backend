const mongoose = require('mongoose');

// One logical document per type. Holds the version counter so version numbers stay monotonic even when drafts are deleted.
// The text itself lives in LegalDocumentVersion.
const TYPES = ['privacy_policy', 'terms_and_conditions', 'refund_cancellation_policy'];

const legalDocumentSchema = new mongoose.Schema({
    type: { type: String, required: true, unique: true, enum: TYPES },
    lastVersion: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

legalDocumentSchema.statics.TYPES = TYPES;

module.exports = mongoose.models.LegalDocument || mongoose.model('LegalDocument', legalDocumentSchema);
