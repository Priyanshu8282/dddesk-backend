const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, unique: true, required: true },
    description: String,
    image: String,

    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    type: { type: String, enum: ['Standard', 'Grocery', 'Restaurant', 'Service', 'Common'], default: 'Standard' },
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

    // Configurable masters mapping
    attributeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attribute' }],
    variantTypeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'VariantType' }],
    addonIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Addon' }],

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    order: { type: Number, default: 0 },

    tenantId: { type: mongoose.Schema.Types.ObjectId }, // SaaS Ready

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Slugify name before validation
categorySchema.pre('validate', function () {
    if (this.name && !this.slug) {
        let baseSlug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        if (this.masterCategory) {
            baseSlug += '-' + this.masterCategory.toLowerCase();
        }
        this.slug = baseSlug;
    }
});

// Soft delete filtering
categorySchema.pre('find', function () { this.where({ isDeleted: false }); });
categorySchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('Category', categorySchema);
