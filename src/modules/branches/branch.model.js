const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const branchSchema = new Schema({
  libraryId:  { type: ObjectId, ref: 'Library', required: true, index: true },
  name:       { type: String, required: true, trim: true },
  address:    { type: String, default: '' },
  city:       { type: String, default: '' },
  state:      { type: String, default: '' },
  pincode:    { type: String, default: '' },
  mobile:     { type: String, default: '' },
  email:      { type: String, default: '', lowercase: true },
  managerId:  { type: ObjectId, ref: 'Admin', default: null },
  isMain:     { type: Boolean, default: false },
  isActive:   { type: Boolean, default: true },
  openingTime: { type: String, default: '06:00 AM' },
  closingTime: { type: String, default: '11:00 PM' },
  maxStudents: { type: Number, default: 0 },  // 0 = inherit library limit
  maxSeats:    { type: Number, default: 0 },
  notes:      { type: String, default: '' },
  isDeleted:  { type: Boolean, default: false, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Branch', branchSchema);
