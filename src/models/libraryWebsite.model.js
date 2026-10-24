const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const gallerySchema = new Schema({
  url:     { type: String, required: true },
  caption: { type: String, default: '' },
  order:   { type: Number, default: 0 },
}, { _id: true });

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
  gallery:    { type: [gallerySchema], default: [] },

  openingHours: {
    openingTime:   { type: String, default: '06:00 AM' },
    closingTime:   { type: String, default: '11:00 PM' },
    openDays:      { type: String, default: 'Monday - Sunday' },
    weeklyHoliday: { type: String, default: 'None' },
  },
  weeklyHolidays: { type: [String], default: [] },

  rules: { type: String, default: '' },
  terms: { type: String, default: '' },

  theme: {
    primaryColor:   { type: String, default: '' },
    secondaryColor: { type: String, default: '' },
    accentColor:    { type: String, default: '' },
    fontFamily:     { type: String, default: '' },
    heroImage:      { type: String, default: '' },
    logo:           { type: String, default: '' },
    layout:         { type: String, default: 'default' },
  },

  location: {
    latitude:  { type: Number, default: null },
    longitude: { type: Number, default: null },
    mapUrl:    { type: String, default: '' },
  },

  seo: {
    title:       { type: String, default: '' },
    description: { type: String, default: '' },
    ogImage:     { type: String, default: '' },
  },

  // Section visibility
  showPlans:            { type: Boolean, default: true },
  showSeatAvailability: { type: Boolean, default: true },
  showStories:          { type: Boolean, default: true },
  showNotices:          { type: Boolean, default: true },
  showReviews:          { type: Boolean, default: true },

  isPublished: { type: Boolean, default: false },

}, { timestamps: true });

module.exports = mongoose.model('LibraryWebsite', libraryWebsiteSchema);
