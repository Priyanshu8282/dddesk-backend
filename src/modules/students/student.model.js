const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const studentSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    mobile: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    
    rollNumber: { type: String },
    
    dob: { type: Date },
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },
    
    aadhaarNumber: { type: String, trim: true },
    aadhaarCardImage: [{ type: String }],
    
    guardianName: { type: String, trim: true },
    guardianMobile: { type: String, trim: true },
    guardianOccupation: { type: String, trim: true },
    
    seatNumber: { type: String },
    seatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', default: null },

    address: { type: String },
    city: { type: String },
    state: { type: String },
    country: { type: String },
    countryCode: { type: String },
    stateCode: { type: String },
    pincode: { type: String },
    
    status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
    isDeleted: { type: Boolean, default: false },
    
    lastLogin: Date,
    profileImage: String,
    otp: { type: String },
    fcmTokens: [{ type: String }],
    
    joiningDate: { type: Date, default: Date.now },
    expiryDate: { type: Date }, // Membership expiry
    
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    planStatus: { type: String, enum: ['none', 'pending', 'active', 'expired'], default: 'none' },
    planStartDate: { type: Date },
    paymentMethod: { type: String, enum: ['cash', 'online', 'unpaid'], default: 'unpaid' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Hash password before saving
studentSchema.pre('save', async function () {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

// Compare password method
studentSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

// Middleware for soft delete filtering
studentSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Student', studentSchema);
