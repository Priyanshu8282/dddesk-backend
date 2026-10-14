const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/setting.service');

exports.getSettings = catchAsync(async (req, res) => {
  const data = await svc.getSettings(req.query.key);
  res.status(200).json({
    success: true,
    message: 'Settings retrieved successfully',
    data
  });
});

exports.updateSetting = catchAsync(async (req, res) => {
  const { key, value, description } = req.body;
  if (!key || value === undefined) throw new ApiError(400, 'Key and value are required');
  const setting = await svc.upsertSetting(key, value, description);
  res.status(200).json({
    success: true,
    message: 'Setting updated successfully',
    data: setting
  });
});
