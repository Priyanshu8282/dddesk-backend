const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
    vendorProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProduct' },
    variantId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
    image: String,
    sku: String,
    quantity: Number,
    price: Number,
    mrp: Number,
    subtotal: Number,
});

const deliveryAddressSchema = new mongoose.Schema({
    label: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pincode: String,
    landmark: String,
}, { _id: false });

const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    items: [orderItemSchema],
    addressId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deliveryAddress: deliveryAddressSchema,
    subtotal: Number,
    deliveryFee: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    totalAmount: Number,
    platformFee: { type: Number, default: 0 },
    vendorPayout: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['cod', 'online', 'wallet', 'upi', 'card', 'razorpay'], default: 'cod' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: {
        type: String,
        enum: ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'],
        default: 'placed'
    },
    notes: String,
    cancelReason: String,
}, { timestamps: true });

// Auto-generate order number before validation
orderSchema.pre('save', async function () {
    if (this.isNew && !this.orderNumber) {
        try {
            const count = await mongoose.model('Order').countDocuments();
            this.orderNumber = `ORD-${Date.now().toString().slice(-6)}-${String(count + 1).padStart(4, '0')}`;
        } catch (e) {
            this.orderNumber = `ORD-${Date.now()}`;
        }
    }
});

module.exports = mongoose.model('Order', orderSchema);
