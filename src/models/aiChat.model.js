const mongoose = require('mongoose');

// Chat log. Only the question, the answer and small metadata are stored; the data context sent
// to the model is never persisted.
const pendingActionSchema = new mongoose.Schema({
    type: { type: String, enum: ['SEND_FEE_REMINDERS'], required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    preview: { type: mongoose.Schema.Types.Mixed, default: {} },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['proposed', 'confirmed', 'executed', 'cancelled', 'failed'], default: 'proposed' },
    expiresAt: { type: Date, required: true },
    executedAt: { type: Date },
    result: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const aiChatSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true,
        index: true
    },
    prompt: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    intent: {
        type: String,
        default: 'GENERAL_ASSISTANT'
    },
    reply: {
        type: String,
        required: true
    },
    // Small, non-PII metadata only: { engine, dataAvailable, fellBack, ... }
    meta: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    suggestedActions: [{
        type: String
    }],
    pendingAction: {
        type: pendingActionSchema,
        default: undefined
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

aiChatSchema.index({ libraryId: 1, adminId: 1, createdAt: -1 });

aiChatSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('AiChat', aiChatSchema);
