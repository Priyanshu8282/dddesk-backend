const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/permission.service');

exports.createPermission = catchAsync(async (req, res) => {
  const permission = await svc.createPermission(req.body);
  res.status(201).json({
    success: true,
    message: 'Permission created successfully',
    data: permission
  });
});

exports.getPermissions = catchAsync(async (req, res) => {
  const permissions = await svc.listPermissions();
  res.status(200).json({
    success: true,
    message: 'Permissions retrieved successfully',
    data: permissions
  });
});

exports.updatePermission = catchAsync(async (req, res) => {
  const permission = await svc.updatePermission(req.params.id, req.body);
  res.status(200).json({
    success: true,
    message: 'Permission updated successfully',
    data: permission
  });
});

exports.deletePermission = catchAsync(async (req, res) => {
  await svc.deletePermission(req.params.id);
  res.status(200).json({
    success: true,
    message: 'Permission deleted successfully'
  });
});
