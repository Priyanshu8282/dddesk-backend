const express = require('express');
const router = express.Router();
const subcategoryController = require('./subcategory.controller');
const upload = require('../../middlewares/upload.middleware');
const Authentication = require('../../middlewares/auth.middleware');

router.use(Authentication);

router.post('/', upload.single('image'), subcategoryController.createSubcategory);
router.get('/', subcategoryController.getSubcategories);
router.get('/:id', subcategoryController.getSubcategoryById);
router.put('/:id', upload.single('image'), subcategoryController.updateSubcategory);
router.patch('/:id/status', subcategoryController.updateSubcategoryStatus);
router.delete('/:id', subcategoryController.deleteSubcategory);

module.exports = router;
