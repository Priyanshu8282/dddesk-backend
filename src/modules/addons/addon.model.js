const mongoose = require('mongoose');

const addonSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

addonSchema.pre('find', function () { this.where({ isDeleted: false }); });
addonSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('Addon', addonSchema);
