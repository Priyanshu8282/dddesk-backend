const mongoose = require('mongoose');

// History of maintenance windows: who switched what, when and why (shown in the super admin panel)
const maintenanceEventSchema = new mongoose.Schema({
    action: { type: String, required: true, enum: ['enable', 'schedule', 'update', 'disable', 'cancel'] },
    mode: { type: String, default: null },
    scope: { type: String, default: null },
    libraryCount: { type: Number, default: 0 },
    message: { type: String, default: null },
    reason: { type: String, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    estimatedBackAt: { type: Date, default: null },
    pauseCrons: { type: Boolean, default: false },
    notified: { type: Boolean, default: false },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    byName: { type: String, default: null },
    ip: { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

maintenanceEventSchema.index({ createdAt: -1 });

module.exports = mongoose.models.MaintenanceEvent || mongoose.model('MaintenanceEvent', maintenanceEventSchema);
