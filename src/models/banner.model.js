const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
{
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Library",
        required: true
    },

    title: {
        type: String,
        required: true
    },

    description: {
        type: String
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

    redirectUrl: {
        type: String
    },

    startDate: {
        type: Date,
        required: true
    },

    endDate: {
        type: Date,
        required: true
    },

    displayOrder: {
        type: Number,
        default: 1
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

// Middleware for soft delete filtering
bannerSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model("Banner", bannerSchema);
