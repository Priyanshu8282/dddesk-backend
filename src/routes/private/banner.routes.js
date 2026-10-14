const express = require('express');
const bannerController = require('../../controllers/banner.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { bannerValidation } = require('../../validations');

const router = express.Router();

router.post('/create-banner', upload.single('image'), validate(bannerValidation.createBanner), bannerController.createBanner);
router.get('/get-banners', bannerController.getBanners);
router.get('/get-banner/:id', bannerController.getBannerById);
router.put('/update-banner/:id', upload.single('image'), bannerController.updateBanner);
router.put('/toggle-banner/:id', bannerController.toggleBanner);
router.delete('/delete-banner/:id', bannerController.deleteBanner);

module.exports = router;
