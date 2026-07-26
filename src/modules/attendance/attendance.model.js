const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true
    },
    libraryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Library',
      required: true,
      index: true
    },
    date: {
      type: Date,
      required: true,
      default: () => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d;
      }
    },
    checkIn: {
      type: Date,
      required: true
    },
    checkOut: {
      type: Date
    },
    duration: {
      type: Number, // duration in minutes
      default: 0
    },
    status: {
      type: String,
      enum: ['present', 'absent'],
      default: 'present'
    }
  },
  {
    timestamps: true
  }
);

// Prevent multiple punch-ins for the same student on the same date unless they have multiple entries (though here we assume one per day)
// attendanceSchema.index({ studentId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
