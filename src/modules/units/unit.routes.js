const express = require('express');
const router = express.Router();
const unitController = require('./unit.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

router.post('/create-unit', Authentication, unitController.createUnit);
router.get('/get-units', Authentication, unitController.getUnits);
router.put('/update-unit/:id', Authentication, unitController.updateUnit);
router.patch('/update-status/:id', Authentication, unitController.updateUnitStatus);
router.delete('/delete-unit/:id', Authentication, unitController.deleteUnit);


module.exports = router;
