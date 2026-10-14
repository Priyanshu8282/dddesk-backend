const express = require('express');
const c = require('../../controllers/enquiry.controller');
const validate = require('../../middlewares/validate.middleware');
const { enquiryValidation } = require('../../validations');

const router = express.Router();

router.get('/', c.getEnquiries);
router.post('/', validate(enquiryValidation.createEnquiry), c.createEnquiry);
router.get('/:id', c.getEnquiryById);
router.put('/:id', validate(enquiryValidation.updateEnquiry), c.updateEnquiry);
router.delete('/:id', c.deleteEnquiry);

module.exports = router;
