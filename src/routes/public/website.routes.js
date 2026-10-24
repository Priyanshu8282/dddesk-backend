const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../../controllers/libraryWebsite.controller');
const validate = require('../../middlewares/validate.middleware');
const { tenantFromIdParam } = require('../../middlewares/publicLibrary.middleware');
const { websiteValidation } = require('../../validations');

const router = express.Router();

const msg = (m) => ({ success: false, code: 429, message: m });
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: msg('Too many requests. Please slow down.') });
const enquiryLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: msg('Too many enquiries from this device. Please try again later.') });

router.use(readLimiter);

// Enquiry with libraryId in the body. Must stay above /:libraryId routes.
router.post('/enquiry', enquiryLimiter, validate(websiteValidation.bodyPublicEnquiry), ctrl.submitEnquiryByBody);

// Full site payload (library must be active AND website published)
router.get('/:libraryId', validate(websiteValidation.libraryIdParam), ctrl.getPublicProfile);

// Granular, lazy-loadable sections
const t = tenantFromIdParam();
router.get('/:libraryId/plans', t, ctrl.getPlans);
router.get('/:libraryId/seats', t, ctrl.getSeats);
router.get('/:libraryId/stories', t, ctrl.getStories);
router.get('/:libraryId/notices', t, ctrl.getNotices);
router.get('/:libraryId/banners', t, ctrl.getBanners);
router.get('/:libraryId/offers', t, ctrl.getOffers);
router.get('/:libraryId/gallery', t, ctrl.getGallery);
router.get('/:libraryId/reviews', t, ctrl.getReviews);

// Library-bound enquiry
router.post('/:libraryId/enquiry', enquiryLimiter, validate(websiteValidation.publicEnquiry), t, ctrl.submitEnquiry);

module.exports = router;
