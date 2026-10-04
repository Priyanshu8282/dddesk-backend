const mongoose = require('mongoose');

const attendanceQRSchema = new mongoose.Schema({
  libraryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Library',
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  nonce: {
    type: String,
    required: true,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 }   // MongoDB TTL auto-deletes expired docs
  },
  isUsed: {
    type: Boolean,
    default: false
  },
  usedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student'
  },
  usedAt: {
    type: Date
  },
  failedAttempts: [{
    studentId: mongoose.Schema.Types.ObjectId,
    reason: String,
    ip: String,
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

module.exports = mongoose.model('AttendanceQR', attendanceQRSchema);
