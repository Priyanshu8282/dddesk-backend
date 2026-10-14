const express = require('express');
const c = require('../../controllers/expense.controller');
const validate = require('../../middlewares/validate.middleware');
const { expenseValidation } = require('../../validations');

const router = express.Router();

router.get('/', c.getExpenses);
router.post('/', validate(expenseValidation.createExpense), c.createExpense);
router.get('/:id', c.getExpenseById);
router.put('/:id', c.updateExpense);
router.delete('/:id', c.deleteExpense);

module.exports = router;
