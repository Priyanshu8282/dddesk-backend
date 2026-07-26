const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },

    userType: { 
        type: String, 
        enum: ['superadmin', 'admin', 'staff'], 
        default: 'staff',
        required: true 
    },

    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },

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
    profileImage: String,

    otp: { type: String },
    fcmTokens: [{ type: String }],
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library' }, // Links user to the library institution
    tenantId: { type: mongoose.Schema.Types.ObjectId }, // For future SaaS scalability
    
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

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

// Compare password method
adminSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
