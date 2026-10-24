const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Never selected by default; login/change-password use .select('+password')
    password: { type: String, required: true, select: false },

    userType: { 
        type: String, 
        enum: ['superadmin', 'admin', 'staff'], 
        default: 'staff',
        required: true 
    },

    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },

    // Branches this staff member operates in (empty = all branches of the library)
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],

    // 🔹 Contact Info
    mobile: {
        type: String,
        required: true,
        trim: true
    },
    alternativeMobileNumber: {
        type: String,
        trim: true
    },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    country: { type: String },
    pincode: { type: String },

    // 🔹 Documents (For staff)
    documents: [
        {
            name: String,
            files: [String] // image URLs
        }
    ],

    // 🔹 Job Info
    joiningDate: {
        type: Date,
        default: Date.now
    },

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    lastLogin: Date,
    // Tokens issued before this instant are rejected (set on password reset so a stolen session dies)
    tokensValidAfter: { type: Date },
    profileImage: String,

    // OTP state (otp is stored as a SHA-256 hash)
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    // Password-login lockout (see auth.service login)
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    fcmTokens: [{ type: String }],
    // Guided product tour progress (follows the user across devices). version = TOUR_VERSION it was last finished/skipped for
    tour: {
        completed: { type: Boolean, default: false },
        skippedAt: { type: Date, default: null },
        lastStep: { type: Number, default: 0, min: 0, max: 50 },
        version: { type: Number, default: 0 },
    },
    // true when the owner registered with only a mobile number (e-mail below is a generated placeholder, never mailed)
    emailIsPlaceholder: { type: Boolean, default: false },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library' }, // Links user to the library institution
    tenantId: { type: mongoose.Schema.Types.ObjectId }, // For future SaaS scalability
    
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true,
    toJSON: {
        transform: (doc, ret) => { delete ret.password; delete ret.otp; delete ret.otpExpires; delete ret.otpAttempts; return ret; }
    },
    toObject: {
        transform: (doc, ret) => { delete ret.password; delete ret.otp; delete ret.otpExpires; delete ret.otpAttempts; return ret; }
    }
});

adminSchema.index({ libraryId: 1, userType: 1, isDeleted: 1 });
adminSchema.index({ mobile: 1 });

// Middleware for soft delete filtering
adminSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

// Hash password before saving
adminSchema.pre('save', async function () {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

// Compare password method (requires the document to be loaded with +password)
adminSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
