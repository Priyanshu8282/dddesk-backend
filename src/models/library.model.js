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

    description: { type: String, trim: true, default: "" },

    // What kind of place it is (optional, chosen at sign-up)
    libraryType: { type: String, enum: ["", "library", "study_room", "reading_room", "self_study", "coaching", "other"], default: "" },

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

    email: {
      type: String,
      lowercase: true,
      trim: true
    },

    // 🔹 Legacy auth copy. Credentials live on the owner Admin account; this field is no longer
    // written by the app and is never selected/serialized.
    password: {
      type: String,
      select: false
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
    district: String,
    mapLocation: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
      url: { type: String, trim: true }
    },

    // 🔹 Branding
    logo: {
      type: String
    },

    coverImage: { type: String },

    profileImage: {
      type: String
    },

    photos: [String],

    brand: {
      primaryColor: { type: String, trim: true, default: "#4f46e5" },
      secondaryColor: { type: String, trim: true, default: "#0ea5e9" },
      theme: { type: String, enum: ["light", "dark", "auto"], default: "light" }
    },

    // 🔹 Online Presence
    website: {
      type: String,
      trim: true
    },

    socialLinks: {
      facebook: { type: String, trim: true },
      instagram: { type: String, trim: true },
      twitter: { type: String, trim: true },
      youtube: { type: String, trim: true },
      linkedin: { type: String, trim: true },
      whatsapp: { type: String, trim: true }
    },

    gstNumber: {
      type: String,
      trim: true,
      uppercase: true
    },

    facilities: [{ type: String, trim: true }],

    // Initial/total seat capacity declared by owner
    seatCapacity: { type: Number, min: 0, default: 0 },

    // 🔹 Unique Identification
    libraryCode: {
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

    // 🔹 Fee policy (credit / reminders) - consumed by payments
    feePolicy: {
      allowCredit: { type: Boolean, default: true },
      maxCreditAmount: { type: Number, min: 0, default: 0 },   // 0 = no cap
      maxCreditDays: { type: Number, min: 0, default: 0 },     // 0 = no cap
      graceDays: { type: Number, min: 0, default: 0 },
      reminderFrequencyDays: { type: Number, min: 0, default: 3 },
      blockAfterDue: { type: Boolean, default: false }
    },

    // 🔹 Membership policy (pause / extend) - consumed by student membership flows
    membershipPolicy: {
      allowPause: { type: Boolean, default: true },
      maxPauseDays: { type: Number, min: 0, default: 30 },
      allowExtend: { type: Boolean, default: true },
      maxExtendDays: { type: Number, min: 0, default: 30 },
      releaseSeatOnPause: { type: Boolean, default: false }
    },

    // 🔹 Attendance rules - consumed by attendance
    attendanceRules: {
      graceMinutes: { type: Number, min: 0, default: 10 },
      lateAfterMinutes: { type: Number, min: 0, default: 15 },
      autoReleaseNoShow: { type: Boolean, default: false },
      noShowGraceMinutes: { type: Number, min: 0, default: 60 },
      // true = reject check-in outside the plan's shift window (+/- graceMinutes); false = only flag
      enforceShift: { type: Boolean, default: false }
    },

    notificationPrefs: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      feeReminders: { type: Boolean, default: true },
      expiryReminders: { type: Boolean, default: true },
      newEnquiry: { type: Boolean, default: true },
      newComplaint: { type: Boolean, default: true },
      attendanceAlerts: { type: Boolean, default: false }
    },

    // 🔹 Receipt numbering - consumed by payments
    receipt: {
      prefix: { type: String, default: 'RCPT', trim: true },
      nextNumber: { type: Number, min: 1, default: 1 },
      footerNote: { type: String, trim: true, default: "" }
    },

    // 🔹 GST on student fee receipts (configurable per library - the library / its CA decides applicability).
    // Fee amounts are treated as GST-INCLUSIVE: tax is extracted from the amount collected, never added on top.
    feeTax: {
      gstEnabled: { type: Boolean, default: false },
      gstRate: { type: Number, min: 0, max: 28, default: 18 },
      sacCode: { type: String, trim: true, default: '999293' }
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
    weeklyHolidays: [{ type: String, trim: true }],

    rules: { type: String, default: "" },
    terms: { type: String, default: "" },

    // 🔹 Regional
    timezone: { type: String, default: "Asia/Kolkata", trim: true },
    currency: { type: String, default: "INR", trim: true, uppercase: true },

    // 🔹 Status Control
    status: {
      type: String,
      enum: ["active", "pending", "suspended", "rejected"],
      default: "pending"
    },

    // Reason given when SA rejects or suspends
    statusReason: {
      type: String,
      default: null
    },
    // Consent given at self-registration (DPDP): which notice version, when, from where
    registrationConsent: {
      terms: { type: Boolean, default: false }, privacy: { type: Boolean, default: false }, marketing: { type: Boolean, default: false },
      version: { type: String, default: null }, at: { type: Date, default: null }, ip: { type: String, default: null }
    },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

    // Platform subscription (managed by SA)
    // subscriptionPlanId links to the PlatformPlan document in the catalog
    subscriptionPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlatformPlan',
      default: null
    },
    // subscriptionPlan stores the plan name string for quick display without a join
    subscriptionPlan: {
      type: String,
      default: 'free'
    },

    subscriptionExpiry: {
      type: Date,
      default: null
    },
    // Free trial window set at approval; subscriptionIsTrial marks a trial-type assignment
    trialEndsAt: { type: Date, default: null },
    subscriptionIsTrial: { type: Boolean, default: false },

    // SaaS plan lifecycle (spec 29): billing cycle, scheduled change, cancellation, persisted state, reminders
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    subscriptionStatus: { type: String, enum: ['trial', 'active', 'grace', 'expired', 'cancelled'], default: undefined },
    pendingPlanChange: {
        type: new mongoose.Schema({
            platformPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan', required: true },
            billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
            requestedAt: { type: Date, default: Date.now },
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
            blockedReason: { type: String }
        }, { _id: false }),
        default: undefined
    },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelReason: { type: String, trim: true, maxlength: 500 },
    cancelRequestedAt: { type: Date },
    // "<expiry ms>:<7|3|1>" of the last renewal reminder sent (idempotency)
    lastReminderStage: { type: String },

    // Entitlement snapshot — copied from PlatformPlan at assignment time for fast enforcement
    planLimits: {
      maxStudents: { type: Number, default: 100 },
      maxSeats: { type: Number, default: 50 },
      maxStaff: { type: Number, default: 3 },
      maxBranches: { type: Number, default: 0 } // 0 = unlimited
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
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => { delete ret.password; delete ret.id; return ret; }
    },
    toObject: {
      virtuals: true,
      transform: (doc, ret) => { delete ret.password; delete ret.id; return ret; }
    }
  }
);

librarySchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
// Mobile is unique only among non-deleted libraries so a deleted library's number can re-register
librarySchema.index({ mobile: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

// Atomic yearly serial for library codes: LIB-YYYY-0001
const nextLibraryCode = async (Model) => {
  const GlobalSetting = require("./setting.model");
  const year = new Date().getFullYear();
  const prefix = `LIB-${year}-`;
  for (let i = 0; i < 50; i++) {
    const seq = await GlobalSetting.findOneAndUpdate(
      { key: `seq:libraryCode:${year}` },
      { $inc: { value: 1 }, $setOnInsert: { description: "Library code sequence", isPublic: false } },
      { returnDocument: "after", upsert: true }
    );
    const code = `${prefix}${String(seq.value).padStart(4, "0")}`;
    // Skip codes already issued by the previous (non-atomic) generator
    if (!(await Model.exists({ libraryCode: code }))) return code;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
};

librarySchema.pre("save", async function () {
  if (this.isNew && !this.libraryCode) {
    this.libraryCode = await nextLibraryCode(this.constructor);
  }

  // Legacy password field: hash if somebody still sets it
  if (this.password && this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
  }
});

// Compare password method (legacy; requires +password)
librarySchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("Library", librarySchema);
