const LibraryWebsite = require('../models/libraryWebsite.model');
const Library        = require('../models/library.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const LIBRARY_FIELDS = 'name ownerName email mobile address city state pincode logo profileImage photos workingHours website slug';

exports.getWebsiteSettings = async (libraryId) => {
  let doc = await LibraryWebsite.findOne({ libraryId }).lean();
  if (!doc) doc = await LibraryWebsite.create({ libraryId });
  const library = await Library.findById(libraryId).select(LIBRARY_FIELDS).lean();
  return { ...doc, library };
};

exports.updateWebsiteSettings = async (libraryId, body) => {
  const FIELDS = ['about','announcement','socialLinks','facilities','openingHours','isPublished'];
  const update = {};
  FIELDS.forEach(k => { if (body[k] !== undefined) update[k] = body[k]; });
  return LibraryWebsite.findOneAndUpdate(
    { libraryId }, { $set: update },
    { new: true, upsert: true, runValidators: true }
  ).lean();
};

exports.getPublicProfile = async (slug) => {
  const library = await Library.findOne({ slug, isDeleted: { $ne: true }, status: 'active' })
    .select(LIBRARY_FIELDS).lean();
  if (!library) throw err('Library not found.', 404);
  const website = await LibraryWebsite.findOne({ libraryId: library._id }).lean();
  return { library, website };
};
