const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/permission.service');
const audit      = require('../utils/audit');

exports.createPermission = catchAsync(async (req, res) => {
  const permission = await svc.createPermission(req.body);
  await audit(req, 'permission.create', 'Permission', permission._id, { key: permission.key });
  res.status(201).json({ success: true, message: 'Permission created successfully', data: permission });
});

exports.getPermissions = catchAsync(async (req, res) => {
  const permissions = await svc.listPermissions({
    includePlatform: req.userType === 'superadmin',
    grouped: req.query.grouped === 'true',
  });
  res.status(200).json({ success: true, message: 'Permissions retrieved successfully', data: permissions });
});

exports.updatePermission = catchAsync(async (req, res) => {
  const permission = await svc.updatePermission(req.params.id, req.body);
  await audit(req, 'permission.update', 'Permission', permission._id, { key: permission.key });
  res.status(200).json({ success: true, message: 'Permission updated successfully', data: permission });
});

exports.deletePermission = catchAsync(async (req, res) => {
  const p = await svc.deletePermission(req.params.id);
  await audit(req, 'permission.delete', 'Permission', p._id, { key: p.key });
  res.status(200).json({ success: true, message: 'Permission deleted successfully' });
});
