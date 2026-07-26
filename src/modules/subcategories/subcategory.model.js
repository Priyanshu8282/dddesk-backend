const mongoose = require('mongoose');

const subcategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, unique: true, required: true },
    description: String,
    image: String,

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
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
    order: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Slugify name before validation
subcategorySchema.pre('validate', function () {
    if (this.name && !this.slug) {
        let baseSlug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        if (this.masterCategory) {
            baseSlug += '-' + this.masterCategory.toLowerCase();
        }
        this.slug = baseSlug;
    }
});

const Subcategory = mongoose.model('Subcategory', subcategorySchema);

module.exports = Subcategory;
