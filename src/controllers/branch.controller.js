const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const svc = require('../services/branch.service');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');

const lib = (req) => {
  const id = tenantId(req);
  if (!id) throw new ApiError(400, 'No library associated with this account');
  return id;
};

exports.getBranches = catchAsync(async (req, res) => {
  const result = await svc.listBranches(lib(req), req.query);
  res.status(200).json({
    success: true,
    message: 'Branches retrieved successfully',
    data: result.data,
    ...result
  });
});

exports.getBranchById = catchAsync(async (req, res) => {
  const branch = await svc.getBranch(req.params.id, lib(req));
  if (!branch) throw new ApiError(404, 'Branch not found');
  res.status(200).json({ success: true, message: 'Branch retrieved successfully', data: branch });
});

exports.createBranch = catchAsync(async (req, res) => {
  const branch = await svc.createBranch(lib(req), req.body);
  await audit(req, 'branch.create', 'Branch', branch._id, { name: branch.name });
  res.status(201).json({ success: true, message: 'Branch created successfully', data: branch });
});

exports.updateBranch = catchAsync(async (req, res) => {
  const { branch, fields } = await svc.updateBranch(req.params.id, lib(req), req.body);
  await audit(req, 'branch.update', 'Branch', branch._id, { fields });
  res.status(200).json({ success: true, message: 'Branch updated successfully', data: branch });
});

exports.deleteBranch = catchAsync(async (req, res) => {
  const branch = await svc.deleteBranch(req.params.id, lib(req));
  await audit(req, 'branch.delete', 'Branch', branch._id, { name: branch.name });
  res.status(200).json({ success: true, message: 'Branch deleted successfully' });
});

exports.setMainBranch = catchAsync(async (req, res) => {
  const name = await svc.setMainBranch(req.params.id, lib(req));
  await audit(req, 'branch.set_main', 'Branch', req.params.id, { name });
  res.status(200).json({ success: true, message: `"${name}" set as main branch successfully` });
});
