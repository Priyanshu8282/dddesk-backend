const GlobalSetting = require('../models/setting.model');

exports.getSettings = async (key) => {
  const settings = await GlobalSetting.find(key ? { key } : {});
  return key && settings.length > 0 ? settings[0] : settings;
};

exports.upsertSetting = async (key, value, description) =>
  GlobalSetting.findOneAndUpdate(
    { key },
    { key, value, description },
    { new: true, upsert: true, runValidators: true }
  );
