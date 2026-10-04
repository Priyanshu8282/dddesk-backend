const Enquiry = require('../modules/enquiries/enquiry.model');

exports.createEnquiry = async (data) => Enquiry.create(data);

exports.listEnquiries = async (libraryId, query) => {
  const filter = { libraryId };
  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;
  if (query.search) filter.$or = [
    { name:   { $regex: query.search, $options: 'i' } },
    { mobile: { $regex: query.search, $options: 'i' } },
  ];
  const page = parseInt(query.page) || 1, limit = parseInt(query.limit) || 20;
  const [data, total] = await Promise.all([
    Enquiry.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit),
    Enquiry.countDocuments(filter),
  ]);
  return { data, total, page, totalPages: Math.ceil(total / limit) };
};

exports.getEnquiry     = async (id, libraryId) => Enquiry.findOne({ _id: id, libraryId });
exports.updateEnquiry  = async (id, libraryId, body) => Enquiry.findOneAndUpdate({ _id: id, libraryId }, { $set: body }, { new: true });
exports.deleteEnquiry  = async (id, libraryId) => Enquiry.findOneAndUpdate({ _id: id, libraryId }, { $set: { isDeleted: true } });
