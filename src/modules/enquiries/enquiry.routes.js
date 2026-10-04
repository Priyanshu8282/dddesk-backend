const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const c = require('./enquiry.controller');

const router = express.Router();
router.use(Authentication);

router.get('/', c.getEnquiries);
router.post('/', c.createEnquiry);
router.get('/:id', c.getEnquiryById);
router.put('/:id', c.updateEnquiry);
router.delete('/:id', c.deleteEnquiry);

module.exports = router;
