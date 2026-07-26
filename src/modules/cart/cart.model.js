const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
    vendorProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProduct', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    price: { type: Number, required: true },
    mrp: { type: Number },
    name: String,
    image: String,
    sku: String,
}, { _id: true, timestamps: true });

const cartSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    items: [cartItemSchema],
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Cart', cartSchema);
