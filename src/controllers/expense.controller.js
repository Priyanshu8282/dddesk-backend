const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const audit      = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const svc        = require('../services/expense.service');
const { branchFilter, branchForCreate } = require('../utils/branchScope');

const lib = (req) => {
  const id = tenantId(req);
  if (!id) throw new ApiError(400, 'Library context is required');
  return id;
};

exports.createExpense = catchAsync(async (req, res) => {
  const branchId = await branchForCreate(req, lib(req), req.body.branchId);
  const expense = await svc.createExpense(req.body, lib(req), req.user._id, branchId);
  audit(req, 'expense.create', 'Expense', expense._id, { amount: expense.amount, category: expense.category });
  res.status(201).json({ success: true, message: 'Expense recorded successfully', data: expense });
});

exports.getExpenses = catchAsync(async (req, res) => {
  const result = await svc.listExpenses(lib(req), req.query, branchFilter(req));
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="expenses.csv"');
    return res.status(200).send(svc.toCsv(result.data));
  }
  res.status(200).json({ success: true, message: 'Expenses retrieved successfully', ...result });
});

exports.getSummary = catchAsync(async (req, res) => {
  const data = await svc.getSummary(lib(req), branchFilter(req));
  res.status(200).json({ success: true, message: 'Expense summary retrieved successfully', data });
});

exports.exportExpenses = catchAsync(async (req, res) => {
  const scope = branchFilter(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.csv"`);
  await svc.exportExpensesCsv(lib(req), req.query, scope, (chunk) => new Promise((resolve) => (res.write(chunk) ? resolve() : res.once('drain', resolve))));
  res.end();
});

exports.getExpenseById = catchAsync(async (req, res) => {
  const expense = await svc.getExpense(req.params.id, lib(req));
  if (!expense) throw new ApiError(404, 'Expense not found');
  res.status(200).json({ success: true, message: 'Expense retrieved successfully', data: expense });
});

exports.updateExpense = catchAsync(async (req, res) => {
  if (req.body.branchId !== undefined) req.body.branchId = await branchForCreate(req, lib(req), req.body.branchId);
  const expense = await svc.updateExpense(req.params.id, lib(req), req.body);
  if (!expense) throw new ApiError(404, 'Expense not found');
  audit(req, 'expense.update', 'Expense', expense._id, { fields: Object.keys(req.body || {}) });
  res.status(200).json({ success: true, message: 'Expense updated successfully', data: expense });
});

exports.deleteExpense = catchAsync(async (req, res) => {
  const expense = await svc.deleteExpense(req.params.id, lib(req));
  if (!expense) throw new ApiError(404, 'Expense not found');
  audit(req, 'expense.delete', 'Expense', expense._id, { amount: expense.amount });
  res.status(200).json({ success: true, message: 'Expense deleted successfully' });
});
