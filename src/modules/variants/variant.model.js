const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    // e.g., Size: Small, Color: Red
    variantValues: [{
        variantTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantType' },
        value: String
    }],

    price: {
        mrp: { type: Number, required: true },
        sellingPrice: { type: Number, required: true },
        costPrice: { type: Number },
        discount: { type: Number, default: 0 }
    },

    sku: { type: String, unique: true, sparse: true },
    barcode: String,

    stock: { type: Number, default: 0 },
    minStock: { type: Number, default: 0 },

    images: [String],

    // Batch/Expiry support for Grocery
    batchNumber: String,
    expiryDate: Date,

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    tenantId: { type: mongoose.Schema.Types.ObjectId },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

variantSchema.pre('validate', function () {
    if (!this.sku) {
        this.sku = 'SKU-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    }
});

variantSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Variant', variantSchema);
