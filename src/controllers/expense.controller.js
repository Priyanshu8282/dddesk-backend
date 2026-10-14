const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/expense.service');

exports.createExpense = catchAsync(async (req, res) => {
  const expense = await svc.createExpense({ ...req.body, libraryId: req.user.libraryId, createdBy: req.user._id });
  res.status(201).json({
    success: true,
    message: 'Expense recorded successfully',
    data: expense
  });
});

exports.getExpenses = catchAsync(async (req, res) => {
  const result = await svc.listExpenses(req.user.libraryId, req.query);
  res.status(200).json({
    success: true,
    message: 'Expenses retrieved successfully',
    data: result.expenses || result.data || result,
    ...result
  });
});

exports.getExpenseById = catchAsync(async (req, res) => {
  const expense = await svc.getExpense(req.params.id, req.user.libraryId);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.status(200).json({
    success: true,
    message: 'Expense retrieved successfully',
    data: expense
  });
});

exports.updateExpense = catchAsync(async (req, res) => {
  const expense = await svc.updateExpense(req.params.id, req.user.libraryId, req.body);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.status(200).json({
    success: true,
    message: 'Expense updated successfully',
    data: expense
  });
});

exports.deleteExpense = catchAsync(async (req, res) => {
  const expense = await svc.deleteExpense(req.params.id, req.user.libraryId);
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.status(200).json({
    success: true,
    message: 'Expense deleted successfully'
  });
});
