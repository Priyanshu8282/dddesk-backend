const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const svc = require('../services/branch.service');

exports.getBranches = catchAsync(async (req, res) => {
  const result = await svc.listBranches(req.user.libraryId, req.query);
  res.status(200).json({
    success: true,
    message: 'Branches retrieved successfully',
    data: result.branches || result.data || result,
    ...result
  });
});

exports.getBranchById = catchAsync(async (req, res) => {
  const branch = await svc.getBranch(req.params.id, req.user.libraryId);
  if (!branch) throw new ApiError(404, 'Branch not found');
  res.status(200).json({
    success: true,
    message: 'Branch retrieved successfully',
    data: branch
  });
});

exports.createBranch = catchAsync(async (req, res) => {
  const branch = await svc.createBranch(req.user.libraryId, req.body);
  res.status(201).json({
    success: true,
    message: 'Branch created successfully',
    data: branch
  });
});

exports.updateBranch = catchAsync(async (req, res) => {
  const branch = await svc.updateBranch(req.params.id, req.user.libraryId, req.body);
  res.status(200).json({
    success: true,
    message: 'Branch updated successfully',
    data: branch
  });
});

exports.deleteBranch = catchAsync(async (req, res) => {
  await svc.deleteBranch(req.params.id, req.user.libraryId);
  res.status(200).json({
    success: true,
    message: 'Branch deleted successfully'
  });
});

exports.setMainBranch = catchAsync(async (req, res) => {
  const name = await svc.setMainBranch(req.params.id, req.user.libraryId);
  res.status(200).json({
    success: true,
    message: `"${name}" set as main branch successfully`
  });
});
