const express = require('express');
const bannerController = require('../../controllers/banner.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { bannerValidation: v } = require('../../validations');

const router = express.Router();

// Student / app endpoint (any authenticated user of the library). Static path before /:id.
router.get('/active', validate(v.activeBanners), bannerController.getActiveBanners);

// Everything below is staff-only
router.use(requireStaff);

// Legacy aliases (static paths first so /:id never captures them)
router.get('/get-banners', requirePermission('content.view'), validate(v.listBanners), bannerController.getBanners);
router.get('/get-banner/:id', requirePermission('content.view'), validate(v.idParam), bannerController.getBannerById);
router.post('/create-banner', requirePermission('content.create'), upload.single('image'), validate(v.createBanner), bannerController.createBanner);
router.put('/update-banner/:id', requirePermission('content.create'), upload.single('image'), validate(v.updateBanner), bannerController.updateBanner);
router.put('/toggle-banner/:id', requirePermission('content.publish'), validate(v.idParam), bannerController.toggleBanner);
router.delete('/delete-banner/:id', requirePermission('content.publish'), validate(v.idParam), bannerController.deleteBanner);

// REST endpoints (used by frontend /private/banners)
router.get('/', requirePermission('content.view'), validate(v.listBanners), bannerController.getBanners);
router.post('/', requirePermission('content.create'), upload.single('image'), validate(v.createBanner), bannerController.createBanner);
router.patch('/:id/toggle', requirePermission('content.publish'), validate(v.idParam), bannerController.toggleBanner);
router.get('/:id', requirePermission('content.view'), validate(v.idParam), bannerController.getBannerById);
router.put('/:id', requirePermission('content.create'), upload.single('image'), validate(v.updateBanner), bannerController.updateBanner);
router.delete('/:id', requirePermission('content.publish'), validate(v.idParam), bannerController.deleteBanner);

module.exports = router;
