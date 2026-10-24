const mongoose = require('mongoose');

// Messages sent from the public website contact form. Read by the platform team (alerts + database); never shown publicly.
const contactMessageSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    mobile: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    subject: { type: String, trim: true, default: '', maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: ['new', 'read', 'answered', 'spam'], default: 'new', index: true },
    ip: { type: String, default: null },
    // removed automatically after a year so contact details are not kept forever
    expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

contactMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ContactMessage || mongoose.model('ContactMessage', contactMessageSchema);
