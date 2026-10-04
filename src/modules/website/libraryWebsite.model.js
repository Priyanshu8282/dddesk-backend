const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const libraryWebsiteSchema = new Schema({
  libraryId: { type: ObjectId, ref: 'Library', required: true, unique: true, index: true },

  about: { type: String, default: '' },
  announcement: { type: String, default: '' },

  socialLinks: {
    facebook:  { type: String, default: '' },
    instagram: { type: String, default: '' },
    twitter:   { type: String, default: '' },
    youtube:   { type: String, default: '' },
    website:   { type: String, default: '' },
  },

  facilities: { type: [String], default: [] },

  openingHours: {
    openingTime:   { type: String, default: '06:00 AM' },
    closingTime:   { type: String, default: '11:00 PM' },
    openDays:      { type: String, default: 'Monday - Sunday' },
    weeklyHoliday: { type: String, default: 'None' },
  },

  isPublished: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('LibraryWebsite', libraryWebsiteSchema);
