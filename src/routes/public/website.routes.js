const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../../controllers/libraryWebsite.controller');
const validate = require('../../middlewares/validate.middleware');
const { tenantFromSlugParam } = require('../../middlewares/tenantHost.middleware');
const { websiteValidation } = require('../../validations');

const router = express.Router();

const msg = (m) => ({ success: false, code: 429, message: m });
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: msg('Too many requests. Please slow down.') });
const enquiryLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: msg('Too many enquiries from this device. Please try again later.') });

router.use(readLimiter);

// Legacy slug-less enquiry (slug or libraryId in body). Must stay above /:slug routes.
router.post('/enquiry', enquiryLimiter, validate(websiteValidation.legacyPublicEnquiry), ctrl.submitEnquiryLegacy);

// Full site payload (library must be active AND website published)
router.get('/:slug', validate(websiteValidation.slugParam), ctrl.getPublicProfile);

// Granular, lazy-loadable sections
const t = tenantFromSlugParam();
router.get('/:slug/plans', t, ctrl.getPlans);
router.get('/:slug/seats', t, ctrl.getSeats);
router.get('/:slug/stories', t, ctrl.getStories);
router.get('/:slug/notices', t, ctrl.getNotices);
router.get('/:slug/banners', t, ctrl.getBanners);
router.get('/:slug/offers', t, ctrl.getOffers);
router.get('/:slug/gallery', t, ctrl.getGallery);
router.get('/:slug/reviews', t, ctrl.getReviews);

// Slug-bound enquiry
router.post('/:slug/enquiry', enquiryLimiter, validate(websiteValidation.publicEnquiry), t, ctrl.submitEnquiry);

module.exports = router;
