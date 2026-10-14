const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/role.service');

exports.createRole = catchAsync(async (req, res) => {
  const role = await svc.createRole(req);
  res.status(201).json({ success: true, message: 'Role created successfully', data: role });
});

exports.getRoles = catchAsync(async (req, res) => {
  const roles = await svc.listRoles(req);
  res.status(200).json({ success: true, message: 'Roles retrieved successfully', data: roles });
});

exports.getRoleById = catchAsync(async (req, res) => {
  const role = await svc.getRoleById(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role retrieved successfully', data: role });
});

exports.updateRole = catchAsync(async (req, res) => {
  const role = await svc.updateRole(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role updated successfully', data: role });
});

exports.deleteRole = catchAsync(async (req, res) => {
  await svc.deleteRole(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role deleted successfully' });
});
