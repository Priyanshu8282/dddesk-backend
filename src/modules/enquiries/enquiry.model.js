const mongoose = require('mongoose');

const enquirySchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    name: { type: String, required: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    address: { type: String },
    message: { type: String },
    source: {
        type: String,
        enum: ['website', 'walk-in', 'referral', 'phone', 'other'],
        default: 'walk-in'
    },
    status: {
        type: String,
        enum: ['new', 'contacted', 'interested', 'approved', 'converted', 'rejected', 'closed'],
        default: 'new',
        index: true
    },
    followUpDate: { type: Date },
    notes: [{ type: String }],
    // Set when enquiry is converted to a student
    convertedStudentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        default: null
    },
    convertedAt: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

enquirySchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Enquiry', enquirySchema);
