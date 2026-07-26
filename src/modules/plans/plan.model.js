const mongoose = require('mongoose');

const libraryPlanSchema = new mongoose.Schema(
  {
    // 🔹 Link to Library (VERY IMPORTANT 🔥)
    libraryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Library",
      required: true,
      index: true
    },

    // 🔹 Plan Basic Info
    name: {
      type: String,
      required: true,
      trim: true
    },

    description: {
      type: String
    },

    // 🔹 Plan Type
    type: {
      type: String,
      enum: ["premium", "non-premium"],
      default: "non-premium",
      required: true
    },

    // 🔹 Duration (months)
    duration: {
      type: Number, // 1, 3, 6, 12
      required: true
    },

    // 🔹 Pricing
    price: {
      type: Number,
      required: true
    },

    discount: {
      type: Number,
      default: 0
    },

    finalPrice: {
      type: Number
    },

    // 🔹 Features
    features: [
      {
        type: String
        // e.g. "Attendance", "AC Room", "WiFi"
      }
    ],

    // 🔹 Optional: Seat Limit
    seatLimit: {
      type: Number
    },

    // 🔹 Status
    status: {
      type: Boolean,
      default: true
    },

    isDeleted: {
        type: Boolean,
        default: false
    },

    // 🔹 Created By (Admin User)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    }
  },
  {
    timestamps: true
  }
);

// 🔥 Auto calculate final price
libraryPlanSchema.pre("save", function () {
  this.finalPrice = this.price - (this.price * this.discount) / 100;
});

// Middleware for soft delete filtering
libraryPlanSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model("Plan", libraryPlanSchema);
