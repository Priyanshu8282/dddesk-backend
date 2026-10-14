const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
{
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Library",
        required: true,
        index: true
    },

    // null = all branches
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 150
    },

    description: {
        type: String,
        trim: true,
        maxlength: 500
    },

    bannerType: {
        type: String,
        enum: [
            "OFFER",
            "ACHIEVEMENT",
            "SELECTION",
            "ANNOUNCEMENT",
            "SUCCESS_STORY",
            "OTHER"
        ],
        default: "OTHER"
    },

    image: {
        type: String,
        required: true
    },

    // Call to action
    ctaText: {
        type: String,
        trim: true,
        maxlength: 40
    },
    ctaUrl: {
        type: String,
        trim: true,
        maxlength: 500
    },
    // Legacy field; mirrors ctaUrl
    redirectUrl: {
        type: String,
        trim: true
    },

    // Where the banner is shown
    displayLocation: {
        type: String,
        enum: ["website", "app", "both"],
        default: "both"
    },

    startDate: {
        type: Date,
        required: true
    },

    endDate: {
        type: Date,
        required: true
    },

    // Lower number = earlier among equal priority (legacy ordering)
    displayOrder: {
        type: Number,
        default: 1
    },

    // Higher priority banners are shown first
    priority: {
        type: Number,
        default: 0
    },

    isActive: {
        type: Boolean,
        default: true
    },

    isDeleted: {
        type: Boolean,
        default: false
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Admin"
    }

},
{
    timestamps: true
});

bannerSchema.index({ libraryId: 1, isActive: 1, startDate: 1, endDate: 1 });

// Hide soft-deleted banners from reads and from update-by-query operations
bannerSchema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const q = this.getFilter();
    if (q.isDeleted === undefined) this.where({ isDeleted: false });
});

module.exports = mongoose.model("Banner", bannerSchema);
