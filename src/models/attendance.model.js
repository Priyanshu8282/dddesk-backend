const mongoose = require('mongoose');
const { startOfDayIST } = require('../utils/time');

const correctionSchema = new mongoose.Schema({
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  at: { type: Date, default: Date.now },
  reason: { type: String, required: true, trim: true },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed }
}, { _id: true });

const attendanceSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    // Start of the IST calendar day (as a UTC instant)
    date: { type: Date, required: true, default: () => startOfDayIST(new Date()) },
    checkIn: {
      type: Date,
      required: function () { return this.status === 'present'; }
    },
    checkOut: { type: Date },
    duration: { type: Number, default: 0 }, // minutes
    status: { type: String, enum: ['present', 'absent', 'leave'], default: 'present' },
    source: { type: String, enum: ['qr', 'self', 'manual', 'legacy', 'system'], default: 'manual' },

    // true while the session is open; used by a partial unique index (one open session per student)
    open: { type: Boolean },

    // Late / early flags
    // true when checked in outside the plan's shift window (+ grace)
    outsideShift: { type: Boolean, default: false },
    isLate: { type: Boolean, default: false },
    lateByMinutes: { type: Number, default: 0 },
    isEarlyExit: { type: Boolean, default: false },
    earlyByMinutes: { type: Number, default: 0 },

    // Closing details
    autoClosed: { type: Boolean, default: false },
    manualClose: { type: Boolean, default: false },
    manualCloseReason: { type: String, trim: true },
    manualClosedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // Leave details
    leaveReason: { type: String, trim: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    corrections: [correctionSchema]
  },
  { timestamps: true }
);

attendanceSchema.index({ libraryId: 1, date: 1 });
attendanceSchema.index({ studentId: 1, date: 1 });
attendanceSchema.index({ libraryId: 1, open: 1 });
// One open session per student
attendanceSchema.index({ studentId: 1, open: 1 }, { unique: true, partialFilterExpression: { open: true } });

module.exports = mongoose.model('Attendance', attendanceSchema);
