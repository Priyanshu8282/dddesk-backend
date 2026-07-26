const express = require('express');
const bannerController = require('./banner.controller');
const Authentication = require('../../middlewares/auth.middleware');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

router.use(Authentication);

router.post('/create-banner', upload.single('image'), bannerController.createBanner);
router.get('/get-banners', bannerController.getBanners);
router.get('/get-banner/:id', bannerController.getBannerById);
router.put('/update-banner/:id', upload.single('image'), bannerController.updateBanner);
router.put('/toggle-banner/:id', bannerController.toggleBanner);
router.delete('/delete-banner/:id', bannerController.deleteBanner);

module.exports = router;
