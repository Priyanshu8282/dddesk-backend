const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/setting.service');
const audit      = require('../utils/audit');

exports.getSettings = catchAsync(async (req, res) => {
  // GET /settings?key=x  or  GET /settings/:key
  const key = req.params.key || (typeof req.query.key === 'string' ? req.query.key : undefined);
  const data = await svc.getSettings(key, { isSuperAdmin: req.userType === 'superadmin' });
  if (key && !data) throw new ApiError(404, 'Setting not found');
  res.status(200).json({ success: true, message: 'Settings retrieved successfully', data });
});

exports.updateSetting = catchAsync(async (req, res) => {
  // POST /settings {key,value}  or  PUT /settings/:key {value}
  const key = req.params.key || req.body.key;
  const { value, description, isPublic } = req.body;
  if (!key || value === undefined) throw new ApiError(400, 'Key and value are required');
  const setting = await svc.upsertSetting(key, value, description, isPublic);
  await audit(req, 'setting.update', 'GlobalSetting', setting._id, { key });
  res.status(200).json({ success: true, message: 'Setting updated successfully', data: setting });
});
