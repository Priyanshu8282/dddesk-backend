const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'recipientType'
    },
    recipientType: {
        type: String,
        required: true,
        enum: ['Admin', 'Student']
    },
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library'
    },
    type: {
        type: String,
        required: true,
        default: 'system_alert'
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    isRead: {
        type: Boolean,
        default: false
    },
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
