const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const c = require('./expense.controller');

const router = express.Router();
router.use(Authentication);

router.get('/', c.getExpenses);
router.post('/', c.createExpense);
router.get('/:id', c.getExpenseById);
router.put('/:id', c.updateExpense);
router.delete('/:id', c.deleteExpense);

module.exports = router;
