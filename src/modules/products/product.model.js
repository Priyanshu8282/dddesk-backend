const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, unique: true, required: true },
    description: String, // Rich Text

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    categoryName: { type: String },
    subCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory' },
    subCategoryName: { type: String },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' },
    brandName: { type: String },
    unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },

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

    masterCategory: {
        type: String,
        enum: ['Grocery', 'Food'],
        default: 'Grocery'
    },

    productType: {
        type: String,
        enum: ['Single', 'Variant'],
        default: 'Single'
    },

    // Used ONLY for Single Product
    pricing: {
        mrp: { type: Number },
        sellingPrice: { type: Number },
        costPrice: { type: Number },
        taxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tax' },
        discountType: { type: String, enum: ['Fixed', 'Percentage'], default: 'Fixed' },
        discountValue: { type: Number, default: 0 },
        quantity: { type: Number, default: 0 },
        sku: { type: String, sparse: true },
        minStock: { type: Number, default: 0 }
    },

    images: {
        thumbnail: { type: String },
        gallery: [String]
    },

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

productSchema.pre('validate', function () {
    if (this.name && !this.slug) {
        this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    }
});

productSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Product', productSchema);
