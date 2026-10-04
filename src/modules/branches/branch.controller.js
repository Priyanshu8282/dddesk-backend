const catchAsync = require('../../utils/catchAsync');
const svc = require('../../services/branch.service');

exports.getBranches = catchAsync(async (req, res) => {
  const result = await svc.listBranches(req.user.libraryId, req.query);
  res.json({ success: true, ...result });
});

exports.getBranchById = catchAsync(async (req, res) => {
  const branch = await svc.getBranch(req.params.id, req.user.libraryId);
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
  res.json({ success: true, data: branch });
});

exports.createBranch = catchAsync(async (req, res) => {
  const branch = await svc.createBranch(req.user.libraryId, req.body);
  res.status(201).json({ success: true, message: 'Branch created.', data: branch });
});

exports.updateBranch = catchAsync(async (req, res) => {
  const branch = await svc.updateBranch(req.params.id, req.user.libraryId, req.body);
  res.json({ success: true, message: 'Branch updated.', data: branch });
});

exports.deleteBranch = catchAsync(async (req, res) => {
  await svc.deleteBranch(req.params.id, req.user.libraryId);
  res.json({ success: true, message: 'Branch deleted.' });
});

exports.setMainBranch = catchAsync(async (req, res) => {
  const name = await svc.setMainBranch(req.params.id, req.user.libraryId);
  res.json({ success: true, message: `"${name}" is now the main branch.` });
});
