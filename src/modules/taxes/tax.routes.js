const express = require('express');
const router = express.Router();
const taxController = require('./tax.controller');
const Authentication = require('../../middlewares/auth.middleware');

router.post('/create-tax', Authentication, taxController.createTax);
router.get('/get-taxes', Authentication, taxController.getTaxes);
router.put('/update-tax/:id', Authentication, taxController.updateTax);
router.patch('/update-status/:id', Authentication, taxController.updateTaxStatus);
router.delete('/delete-tax/:id', Authentication, taxController.deleteTax);

module.exports = router;
