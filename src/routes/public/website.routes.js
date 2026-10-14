const express = require('express');
const libraryWebsiteCtrl = require('../../controllers/libraryWebsite.controller');
const enquiryCtrl = require('../../controllers/enquiry.controller');
const validate = require('../../middlewares/validate.middleware');
const { enquiryValidation } = require('../../validations');

const router = express.Router();

// Get public profile of a library by its slug (for dynamic tenant websites)
router.get('/:slug', libraryWebsiteCtrl.getPublicProfile);

// Public student admission enquiry from library website
router.post('/enquiry', validate(enquiryValidation.createEnquiry), enquiryCtrl.createEnquiry);

module.exports = router;
