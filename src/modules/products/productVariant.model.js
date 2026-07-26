const mongoose = require('mongoose');

const productVariantSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        index: true
    },

    // Auto-generated or user-defined SKU
    sku: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },

    // E.g. [{"variantTypeId": "...", "valueId": "..."}] representing Pack Size: Single
    attributes: [{
        variantTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantType', required: true },
        valueId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantValue', required: true }
    }],

    // Core Financials
    pricing: {
        mrp: { type: Number, required: true },
        sellingPrice: { type: Number, required: true },
        costPrice: { type: Number },
        taxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tax' },
        discountType: { type: String, enum: ['Fixed', 'Percentage'], default: 'Fixed' },
        discountValue: { type: Number, default: 0 }
    },

    // Physical Specs
    unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },

    // Core Inventory (Batching can be added later, basic stock needed now)
    inventory: {
        quantity: { type: Number, default: 0, required: true },
        minStock: { type: Number, default: 0 }
    },

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Index for aggressive querying by product and attributes
productVariantSchema.index({ productId: 1, 'attributes.valueId': 1 });

// Soft delete middleware
productVariantSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('ProductVariant', productVariantSchema);
