const mongoose = require('mongoose');

// A request to delete a student's own account, or a library owner's whole account. Nothing is ever
// deleted automatically here: a staff/owner must approve a student request (which runs the existing
// DPDP erase flow), and a superadmin must manually review a library request (closing/erasing a whole
// tenant is a separate, deliberate action - this just queues the request for them to act on).
const deletionRequestSchema = new mongoose.Schema({
    type: { type: String, enum: ['student', 'library'], required: true, index: true },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, required: true }, // Student._id (type=student) or Admin._id, the owner (type=library)
    requestedByModel: { type: String, enum: ['Student', 'Admin'], required: true },
    reason: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewNote: { type: String, trim: true, maxlength: 2000 },
    reviewedAt: { type: Date },
}, { timestamps: true });

deletionRequestSchema.index({ libraryId: 1, type: 1, status: 1, createdAt: -1 });
// A student/owner can only ever have one open request at a time
deletionRequestSchema.index({ type: 1, requestedBy: 1, status: 1 });

module.exports = mongoose.model('DeletionRequest', deletionRequestSchema);
