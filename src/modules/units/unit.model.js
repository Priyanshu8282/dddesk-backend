const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema({
    name: { type: String, required: true }, // Kg, Gram, Litre, Piece, Plate, etc.
    shortName: String, // kg, g, l, pc
    masterCategory: { type: String, enum: ['Grocery', 'Food'], default: 'Grocery' },

    // Dynamic Ownership Reference (Admin or Vendor)
    ownerType: {
        type: String,
        enum: ['Admin', 'Vendor'],
        required: true,
        default: 'Admin'
    },
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'ownerType'
    },

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

unitSchema.pre('find', function () { this.where({ isDeleted: false }); });
unitSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('Unit', unitSchema);
