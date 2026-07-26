const express = require('express');
const router = express.Router();
const variantTypeController = require('./variantType.controller');
const Authentication = require('../../middlewares/auth.middleware');
const variantValueController = require('./variantValue.controller');

// Variant Attributes (Old VariantType)
router.post('/create-variant-type', Authentication, variantTypeController.createVariantType);
router.get('/get-variant-types', Authentication, variantTypeController.getVariantTypes);
router.put('/update-variant-type/:id', Authentication, variantTypeController.updateVariantType);
router.patch('/update-status/:id', Authentication, variantTypeController.updateVariantTypeStatus);
router.delete('/delete-variant-type/:id', Authentication, variantTypeController.deleteVariantType);

// Variant Values
router.post('/create-variant-value', Authentication, variantValueController.createVariantValue);
router.get('/get-variant-values', Authentication, variantValueController.getVariantValues);
router.put('/update-variant-value/:id', Authentication, variantValueController.updateVariantValue);
router.patch('/update-value-status/:id', Authentication, variantValueController.updateVariantValueStatus);
router.delete('/delete-variant-value/:id', Authentication, variantValueController.deleteVariantValue);


module.exports = router;
