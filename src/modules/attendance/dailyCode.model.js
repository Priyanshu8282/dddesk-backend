const mongoose = require('mongoose');

const dailyCodeSchema = new mongoose.Schema(
  {
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
    code: {
      type: String,
      required: true,
    },
    date: {
      type: String,
      required: true,
      // Format: YYYY-MM-DD
    },
  },
  { timestamps: true }
);

// Compound index to ensure only one code per student per library per day
dailyCodeSchema.index({ libraryId: 1, studentId: 1, date: 1 }, { unique: true });

const DailyCode = mongoose.model('DailyCode', dailyCodeSchema);

module.exports = DailyCode;
