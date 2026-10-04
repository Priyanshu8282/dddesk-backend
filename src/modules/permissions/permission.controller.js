const catchAsync = require('../../utils/catchAsync');
const svc        = require('../../services/permission.service');

exports.createPermission = catchAsync(async (req, res) => {
  const permission = await svc.createPermission(req.body);
  res.status(201).json(permission);
});

exports.getPermissions = catchAsync(async (req, res) => {
  const permissions = await svc.listPermissions();
  res.json(permissions);
});

exports.updatePermission = catchAsync(async (req, res) => {
  const permission = await svc.updatePermission(req.params.id, req.body);
  res.json(permission);
});

exports.deletePermission = catchAsync(async (req, res) => {
  await svc.deletePermission(req.params.id);
  res.json({ message: 'Permission deleted successfully' });
});
