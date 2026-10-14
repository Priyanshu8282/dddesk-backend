const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const studentSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    // Unique per library (see compound index below), not globally
    mobile: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },

    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },

    rollNumber: { type: String },
    // Auto-generated, sequential per library (e.g. REG-0001)
    registrationNumber: { type: String, trim: true },

    dob: { type: Date },
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },

    aadhaarNumber: { type: String, trim: true },
    aadhaarCardImage: [{ type: String }],

    guardianName: { type: String, trim: true },
    guardianMobile: { type: String, trim: true },
    guardianOccupation: { type: String, trim: true },

    emergencyContact: {
        name: { type: String, trim: true },
        mobile: { type: String, trim: true },
        relation: { type: String, trim: true }
    },
    documents: [{
        type: { type: String, trim: true },   // aadhaar | photo | id_proof | address_proof | other
        name: { type: String, trim: true },
        url: { type: String },
        uploadedAt: { type: Date, default: Date.now }
    }],
    // Internal remarks (staff only)
    notes: [{
        text: { type: String, required: true, trim: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId },
        createdByName: { type: String },
        createdAt: { type: Date, default: Date.now }
    }],

    seatNumber: { type: String },
    seatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', default: null },

    address: { type: String },
    city: { type: String },
    state: { type: String },
    country: { type: String },
    countryCode: { type: String },
    stateCode: { type: String },
    pincode: { type: String },

    status: { type: String, enum: ['active', 'inactive', 'leave', 'suspended'], default: 'active' },
    statusReason: { type: String, trim: true },
    statusChangedAt: { type: Date },
    leaveUntil: { type: Date },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },

    lastLogin: Date,
    tokensValidAfter: { type: Date }, // tokens issued before this are rejected (set on password reset)
    profileImage: String,
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    fcmTokens: [{ type: String }],

    joiningDate: { type: Date, default: Date.now },
    expiryDate: { type: Date }, // Membership expiry

    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    planStatus: { type: String, enum: ['none', 'pending', 'active', 'paused', 'expired'], default: 'none' },
    planStartDate: { type: Date },
    membershipPausedAt: { type: Date },
    membershipPauseReason: { type: String, trim: true },
    paymentMethod: { type: String, enum: ['cash', 'online', 'unpaid'], default: 'unpaid' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Mobile is unique per library among live (non-deleted) students.
studentSchema.index(
    { libraryId: 1, mobile: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false }, name: 'uniq_library_mobile_active' }
);
studentSchema.index(
    { libraryId: 1, registrationNumber: 1 },
    { unique: true, partialFilterExpression: { registrationNumber: { $type: 'string' } }, name: 'uniq_library_regno' }
);
studentSchema.index({ libraryId: 1, isDeleted: 1, status: 1 });
studentSchema.index({ libraryId: 1, planStatus: 1, expiryDate: 1 });

// Never leak secrets in API responses
studentSchema.set('toJSON', {
    transform: (doc, ret) => {
        delete ret.password;
        delete ret.otp;
        delete ret.otpExpires;
        delete ret.otpAttempts;
        delete ret.fcmTokens;
        return ret;
    }
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
studentSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Student', studentSchema);
