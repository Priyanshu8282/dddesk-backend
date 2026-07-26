const mongoose = require('mongoose');

const variantTypeSchema = new mongoose.Schema({
    name: { type: String, required: true }, // Size, Color, etc.
    slug: { type: String, unique: true },
    inputType: {
        type: String,
        enum: ['Dropdown', 'Color Picker', 'Text', 'Radio'],
        default: 'Dropdown'
    },
    required: { type: Boolean, default: false },
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

variantTypeSchema.pre('validate', function () {
    if (this.name && !this.slug) {
        let baseSlug = this.name.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        if (this.masterCategory) {
            baseSlug += '-' + this.masterCategory.toLowerCase();
        }
        this.slug = baseSlug;
    }
});



variantTypeSchema.pre('find', function () { this.where({ isDeleted: false }); });
variantTypeSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('VariantType', variantTypeSchema);
