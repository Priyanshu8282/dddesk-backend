const mongoose = require('mongoose');

// One document per library per rotation window. Many students may use the same
// code inside its validity; each student can use a given code only once.
const attendanceQRSchema = new mongoose.Schema({
  libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
  nonce: { type: String, required: true, unique: true }, // `${libraryId}:${windowNumber}`
  window: { type: Number, required: true },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 } // housekeeping only; the signed token carries its own exp
  },
  scans: [{
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
    direction: { type: String, enum: ['in', 'out'] },
    at: { type: Date, default: Date.now },
    _id: false
  }],
  failedAttempts: [{
    studentId: mongoose.Schema.Types.ObjectId,
    reason: String,
    ip: String,
    timestamp: { type: Date, default: Date.now },
    _id: false
  }]
}, { timestamps: true });

module.exports = mongoose.model('AttendanceQR', attendanceQRSchema);
