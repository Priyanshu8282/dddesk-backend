const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/role.service');

exports.createRole = catchAsync(async (req, res) => {
  const role = await svc.createRole(req);
  res.status(201).json({ success: true, message: 'Role created successfully', data: role });
});

exports.getRoles = catchAsync(async (req, res) => {
  const r = await svc.listRoles(req);
  res.status(200).json({ success: true, message: 'Roles retrieved successfully', data: r.data, total: r.total, page: r.page, limit: r.limit, totalPages: r.totalPages, summary: r.summary });
});

exports.duplicateRole = catchAsync(async (req, res) => {
  const role = await svc.duplicateRole(req, req.params.id);
  res.status(201).json({ success: true, message: 'Role duplicated successfully', data: role });
});

exports.getRoleById = catchAsync(async (req, res) => {
  const role = await svc.getRoleById(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role retrieved successfully', data: role });
});

exports.updateRole = catchAsync(async (req, res) => {
  const role = await svc.updateRole(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role updated successfully', data: role });
});

// Switch a role on or off (the service refuses to turn it off while staff still use it)
exports.setRoleStatus = catchAsync(async (req, res) => {
  req.body = { status: req.body.status };
  const role = await svc.updateRole(req, req.params.id);
  res.status(200).json({ success: true, message: role.status ? 'Role switched on' : 'Role switched off', data: role });
});

exports.deleteRole = catchAsync(async (req, res) => {
  await svc.deleteRole(req, req.params.id);
  res.status(200).json({ success: true, message: 'Role deleted successfully' });
});
