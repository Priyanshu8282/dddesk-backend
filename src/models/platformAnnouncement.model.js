const mongoose = require('mongoose');

// Global announcement from the platform to library owners / staff / students (spec 5.3)
const platformAnnouncementSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    audience: { type: String, enum: ['owners', 'staff', 'students', 'all'], default: 'all', index: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true }
}, { timestamps: true });

platformAnnouncementSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

module.exports = mongoose.model('PlatformAnnouncement', platformAnnouncementSchema);
