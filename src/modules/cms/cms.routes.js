const express = require('express');
const router = express.Router();
const cmsController = require('./cms.controller');
const Authentication = require('../../middlewares/auth.middleware');

// Public GET routes - For Frontend/Mobile App
router.get('/terms', cmsController.getTerms);
router.get('/privacy', cmsController.getPrivacy);
router.get('/faqs', cmsController.getFAQs);
router.get('/contact', cmsController.getContact);
router.get('/about', cmsController.getAbout);

// Admin Protected Routes - For CRUD operations
router.post('/terms', Authentication, cmsController.updateTerms);
router.put('/terms', Authentication, cmsController.updateTerms);

router.post('/privacy', Authentication, cmsController.updatePrivacy);
router.put('/privacy', Authentication, cmsController.updatePrivacy);

router.post('/faqs', Authentication, cmsController.createFAQ);
router.put('/faqs/:id', Authentication, cmsController.updateFAQ);
router.delete('/faqs/:id', Authentication, cmsController.deleteFAQ);

router.put('/contact', Authentication, cmsController.updateContact);
router.put('/about', Authentication, cmsController.updateAbout);

module.exports = router;
