const express = require('express');
const router = express.Router();
const brandController = require('./brand.controller');
const Authentication = require('../../middlewares/auth.middleware');
const upload = require('../../middlewares/upload.middleware');

router.post('/create-brand', Authentication, upload.single('logo'), brandController.createBrand);
router.get('/get-brands', Authentication, brandController.getBrands);
router.get('/get-brand/:id', Authentication, brandController.getBrandById);
router.put('/update-brand/:id', Authentication, upload.single('logo'), brandController.updateBrand);
router.patch('/update-status/:id', Authentication, brandController.updateBrandStatus);
router.delete('/delete-brand/:id', Authentication, brandController.deleteBrand);

// Public route for logo serving
router.get('/public-logo/:id', brandController.getPublicBrandLogo);


module.exports = router;
