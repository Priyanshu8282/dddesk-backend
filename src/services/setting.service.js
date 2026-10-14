const GlobalSetting = require('../models/setting.model');

// Non-superadmins only see public settings; internal ones (counters, secrets) are hidden
exports.getSettings = async (key, { isSuperAdmin = false } = {}) => {
  const filter = key ? { key } : {};
  if (!isSuperAdmin) filter.isPublic = { $ne: false };
  const settings = await GlobalSetting.find(filter).sort({ key: 1 });
  return key ? (settings[0] || null) : settings;
};

exports.upsertSetting = async (key, value, description, isPublic) => {
  const $set = { value };
  if (description !== undefined) $set.description = description;
  if (isPublic !== undefined) $set.isPublic = isPublic;
  return GlobalSetting.findOneAndUpdate(
    { key },
    { $set },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
};
