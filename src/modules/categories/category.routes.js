const express = require('express');
const router = express.Router();
const categoryController = require('./category.controller');
const Authentication = require('../../middlewares/auth.middleware');
// const Authorization = require('../../middlewares/authorization.middleware');

const upload = require('../../middlewares/upload.middleware');

router.post('/create-category', Authentication, upload.single('image'), categoryController.createCategory);
router.get('/get-categories', Authentication, categoryController.getCategories);
router.get('/get-category/:id', Authentication, categoryController.getCategoryById);
router.put('/update-category/:id', Authentication, upload.single('image'), categoryController.updateCategory);
router.patch('/update-category-status/:id', Authentication, categoryController.updateCategoryStatus);
router.delete('/delete-category/:id', Authentication, categoryController.deleteCategory);

module.exports = router;
