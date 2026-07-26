const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
    label: { type: String, default: 'Home' },
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pincode: String,
    landmark: String,
    isDefault: { type: Boolean, default: false },
    coordinates: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
    },
}, { _id: true });

const customerSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, trim: true },
    countryCode: { type: String, default: '+91' },
    name: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    profileImage: String,
    savedAddresses: [addressSchema],
    isActive: { type: Boolean, default: true },
    lastLogin: Date,
    otp: String,
    otpExpiry: Date,
}, { timestamps: true });

module.exports = mongoose.model('Customer', customerSchema);
