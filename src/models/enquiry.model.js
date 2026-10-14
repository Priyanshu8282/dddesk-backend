const mongoose = require('mongoose');

const ENQUIRY_STATUSES = ['new', 'contacted', 'interested', 'approved', 'converted', 'rejected', 'closed'];
const ENQUIRY_SOURCES = ['website', 'walk-in', 'referral', 'phone', 'other'];

const enquirySchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    mobile: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    address: { type: String, trim: true, maxlength: 300 },
    message: { type: String, trim: true, maxlength: 1000 },
    source: {
        type: String,
        enum: ENQUIRY_SOURCES,
        default: 'walk-in'
    },
    // Free text for tracking (e.g. campaign, referrer name)
    sourceDetail: { type: String, trim: true, maxlength: 200 },
    status: {
        type: String,
        enum: ENQUIRY_STATUSES,
        default: 'new',
        index: true
    },
    statusHistory: [{
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        _id: false
    }],
    followUpDate: { type: Date },
    notes: [{ type: String, maxlength: 1000 }],
    // Set when enquiry is converted to a student
    convertedStudentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        default: null
    },
    convertedAt: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    ipAddress: { type: String },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

enquirySchema.index({ libraryId: 1, createdAt: -1 });
enquirySchema.index({ libraryId: 1, mobile: 1 });

// Hide soft-deleted documents from reads and from update-by-query operations
enquirySchema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const q = this.getFilter();
    if (q.isDeleted === undefined) this.where({ isDeleted: false });
});

enquirySchema.statics.STATUSES = ENQUIRY_STATUSES;
enquirySchema.statics.SOURCES = ENQUIRY_SOURCES;

module.exports = mongoose.model('Enquiry', enquirySchema);
