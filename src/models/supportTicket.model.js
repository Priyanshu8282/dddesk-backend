const mongoose = require('mongoose');

const replySchema = new mongoose.Schema({
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    byType: { type: String, enum: ['library', 'support'], required: true },
    byName: { type: String, trim: true },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    at: { type: Date, default: Date.now }
}, { _id: true });

// Library -> platform support ticket (spec 5.1)
const supportTicketSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    category: { type: String, enum: ['general', 'billing', 'technical', 'feature_request', 'account', 'other'], default: 'general' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    replies: { type: [replySchema], default: [] },
    lastReplyAt: { type: Date },
    resolvedAt: { type: Date },
    closedAt: { type: Date }
}, { timestamps: true });

supportTicketSchema.index({ libraryId: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1, updatedAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
