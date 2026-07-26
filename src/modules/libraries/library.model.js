const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const librarySchema = new mongoose.Schema(
  {
    // 🔹 Basic Info
    name: {
      type: String,
      required: true,
      trim: true
    },

    ownerName: {
      type: String,
      required: true,
      trim: true
    },

    // 🔹 Contact Info
    mobile: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },

    alternativeMobileNumber: {
      type: String,
      trim: true
    },

    email: {
      type: String,
      lowercase: true,
      trim: true
    },

    // 🔹 Auth Info (Preserved for system functionality)
    password: {
      type: String,
      required: true
    },

    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true
    },

    // 🔹 Address / Location
    address: String,
    city: String,
    state: String,
    country: String,
    pincode: String,

    // 🔹 Branding
    logo: {
      type: String
    },

    profileImage: {
      type: String
    },

    photos: [String],

    // 🔹 Online Presence
    website: {
      type: String,
      trim: true
    },

    gstNumber: {
      type: String,
      trim: true,
      uppercase: true
    },

    // 🔹 Unique Identification
    libraryCode: {
      type: String,
      unique: true
    },

    slug: {
      type: String,
      unique: true
    },

    // 🔹 Settings
    settings: {
      allowStudentRegistration: {
        type: Boolean,
        default: false
      },
      attendanceEnabled: {
        type: Boolean,
        default: true
      },
      maxStudents: Number
    },

    // 🔹 Working Hours
    workingHours: {
      openingTime: {
        type: String,
        default: "06:00 AM",
        trim: true
      },
      closingTime: {
        type: String,
        default: "11:00 PM",
        trim: true
      },
      weeklyHoliday: {
        type: String,
        default: "None",
        trim: true
      },
      openDays: {
        type: String,
        default: "Monday - Sunday",
        trim: true
      }
    },

    // 🔹 Status Control
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active"
    },

    isDeleted: {
      type: Boolean,
      default: false
    },

    // 🔹 Created By
    createdBy: {
      type: String,
      enum: ["SUPER_ADMIN", "SELF"],
      default: "SUPER_ADMIN"
    },

    createdById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    }
  },
  {
    timestamps: true
  }
);

// Slugify name and generate sequential Library Code before saving
librarySchema.pre("save", async function () {
  // Slugify name
  if (this.name && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
  }

  // Generate Sequential Library Code: LIB-YYYY-0001
  if (this.isNew && !this.libraryCode) {
    try {
      const year = new Date().getFullYear();
      const prefix = `LIB-${year}-`;
      console.log("Generating library code with prefix:", prefix);
      
      // Find the last library created in the current year to get the highest serial
      const lastLibrary = await mongoose.model("Library").findOne({ 
        libraryCode: { $regex: `^${prefix}` } 
      })
      .sort({ createdAt: -1 })
      .select("libraryCode");

      console.log("Last library found:", lastLibrary);

      let serial = 1;
      if (lastLibrary && lastLibrary.libraryCode) {
        const parts = lastLibrary.libraryCode.split("-");
        const lastSerialStr = parts[parts.length - 1];
        const lastSerial = parseInt(lastSerialStr);
        console.log("Parsed last serial string:", lastSerialStr, "as integer:", lastSerial);
        
        if (!isNaN(lastSerial)) {
          serial = lastSerial + 1;
        }
      }

      // Format: LIB-2026-0001 (padded to 4 digits for better scale)
      this.libraryCode = `${prefix}${serial.toString().padStart(4, "0")}`;
      console.log("Final generated libraryCode:", this.libraryCode);
    } catch (error) {
      console.error("Library Code Generation Error:", error);
      // Fallback: Use a timestamp-based short code if sequence fails to avoid registration blockage
      this.libraryCode = `LIB-${Date.now().toString().slice(-6)}`;
      console.log("Fallback generated libraryCode:", this.libraryCode);
    }
  }

  // Hash password
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  
});

// Compare password method
librarySchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("Library", librarySchema);


