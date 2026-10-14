const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    studentName: {
        type: String,
        trim: true
    },
    // public: may be shown on the library website once approved.
    // internal: private feedback for the owner; can never be approved for the website.
    type: {
        type: String,
        enum: ['public', 'internal'],
        default: 'public',
        index: true
    },
    isAnonymous: {
        type: Boolean,
        default: false // If true, public website displays as "Verified Member" instead of full name
    },
    rating: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
        index: true
    },
    review: {
        type: String,
        required: true,
        trim: true,
        minlength: 10,
        maxlength: 1000
    },
    // Hash of the normalized text, used to catch copy-pasted spam
    textHash: {
        type: String,
        index: true,
        select: false
    },
    aspects: {
        cleanliness: { type: Number, min: 1, max: 5 },
        wifi: { type: Number, min: 1, max: 5 },
        comfort: { type: Number, min: 1, max: 5 },
        ambience: { type: Number, min: 1, max: 5 },
        staff: { type: Number, min: 1, max: 5 }
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
        index: true
    },
    isFeatured: {
        type: Boolean,
        default: false,
        index: true // Highlighted testimonial on dynamic website
    },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    moderatedAt: { type: Date },
    ownerReply: {
        text: { type: String, trim: true },
        repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        repliedAt: { type: Date }
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

// One live review per student per library per type
reviewSchema.index(
    { libraryId: 1, studentId: 1, type: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
);

// Soft-delete query filter (reads and update-by-query)
reviewSchema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne'], function () {
    if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
});

module.exports = mongoose.model('Review', reviewSchema);
