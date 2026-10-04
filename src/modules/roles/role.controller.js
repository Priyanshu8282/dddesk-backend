const catchAsync = require('../../utils/catchAsync');
const ApiError   = require('../../utils/ApiError');
const svc        = require('../../services/role.service');

exports.createRole = catchAsync(async (req, res) => {
  const role = await svc.createRole(req.body, req.user?._id);
  res.status(201).json(role);
});

exports.getRoles = catchAsync(async (req, res) => {
  const roles = await svc.listRoles(req.user);
  res.json(roles);
});

exports.getRoleById = catchAsync(async (req, res) => {
  const role = await svc.getRoleById(req.params.id);
  if (!role) throw new ApiError(404, 'Role not found');
  res.json(role);
});

exports.updateRole = catchAsync(async (req, res) => {
  const role = await svc.updateRole(req.params.id, req.body);
  res.json(role);
});

exports.deleteRole = catchAsync(async (req, res) => {
  await svc.deleteRole(req.params.id);
  res.json({ message: 'Role deleted successfully' });
});
