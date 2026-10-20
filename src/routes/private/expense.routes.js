const express = require('express');
const c = require('../../controllers/expense.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { expenseValidation } = require('../../validations');
const { paramGuard } = require('../../utils/branchScope');

const router = express.Router();

router.use(requireStaff);
router.param('id', paramGuard(require('../../models/expense.model')));

// Expenses are financial data: restricted to staff with fee visibility / collection rights (spec 12)
const VIEW = ['fees.view', 'fees.collect', 'expenses.view', 'expenses.manage'];
const WRITE = ['fees.collect', 'expenses.manage', 'expenses.create'];

router.get('/', requirePermission(...VIEW), validate(expenseValidation.queryExpenses), c.getExpenses);
router.post('/', requirePermission(...WRITE), validate(expenseValidation.createExpense), c.createExpense);
router.get('/summary', requirePermission(...VIEW), validate(expenseValidation.summaryQuery), c.getSummary);
router.get('/export', requirePermission(...VIEW), validate(expenseValidation.exportExpenses), c.exportExpenses);
router.get('/:id',requirePermission(...VIEW), validate(expenseValidation.idParam), c.getExpenseById);
router.put('/:id', requirePermission(...WRITE), validate(expenseValidation.updateExpense), c.updateExpense);
router.patch('/:id', requirePermission(...WRITE), validate(expenseValidation.updateExpense), c.updateExpense);
router.delete('/:id', validate(expenseValidation.idParam), requirePermission('expenses.delete', 'DELETE_EXPENSE', 'expenses.manage'), c.deleteExpense);

module.exports = router;
