const mongoose = require('mongoose');

const brandSchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, unique: true, required: true },
    logo: String,
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

    tenantId: { type: mongoose.Schema.Types.ObjectId }, // SaaS Ready

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Slugify name before validation
brandSchema.pre('validate', function () {
    if (this.name && !this.slug) {
        let baseSlug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        if (this.masterCategory) {
            baseSlug += '-' + this.masterCategory.toLowerCase();
        }
        this.slug = baseSlug;
    }
});

// Soft delete filtering
brandSchema.pre('find', function () { this.where({ isDeleted: false }); });
brandSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('Brand', brandSchema);
