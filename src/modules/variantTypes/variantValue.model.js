const mongoose = require('mongoose');

const variantValueSchema = new mongoose.Schema({
    name: { type: String, required: true }, // XL, Red, 500ml
    variantTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantType', required: true },
    sortOrder: { type: Number, default: 0 },
    colorCode: { type: String }, // Used if inputType is Color Picker
    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

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

    tenantId: { type: mongoose.Schema.Types.ObjectId },
    masterCategory: { type: String, enum: ['Grocery', 'Food'], default: 'Grocery' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

variantValueSchema.pre('find', function () { this.where({ isDeleted: false }); });
variantValueSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('VariantValue', variantValueSchema);
