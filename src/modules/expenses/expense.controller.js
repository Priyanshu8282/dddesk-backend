const catchAsync = require('../../utils/catchAsync');
const ApiError   = require('../../utils/ApiError');
const svc        = require('../../services/expense.service');

exports.createExpense = catchAsync(async (req, res) => {
  const expense = await svc.createExpense({ ...req.body, libraryId: req.user.libraryId, createdBy: req.user._id });
  res.status(201).json({ success: true, message: 'Expense recorded', data: expense });
});

exports.getExpenses = catchAsync(async (req, res) => {
  const result = await svc.listExpenses(req.user.libraryId, req.query);
  res.json({ success: true, ...result });
});

exports.getExpenseById = catchAsync(async (req, res) => {
  const expense = await svc.getExpense(req.params.id, req.user.libraryId);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.json({ success: true, data: expense });
});

exports.updateExpense = catchAsync(async (req, res) => {
  const expense = await svc.updateExpense(req.params.id, req.user.libraryId, req.body);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.json({ success: true, message: 'Expense updated', data: expense });
});

exports.deleteExpense = catchAsync(async (req, res) => {
  const expense = await svc.deleteExpense(req.params.id, req.user.libraryId);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.json({ success: true, message: 'Expense deleted' });
});
