const express = require('express');
const c = require('../../controllers/enquiry.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { enquiryValidation: v } = require('../../validations');
const { paramGuard } = require('../../utils/branchScope');

const router = express.Router();

router.use(requireStaff);
router.param('id', paramGuard(require('../../models/enquiry.model')));

// Static routes before /:id
router.get('/stats/conversion', requirePermission('enquiries.view'), validate(v.conversionStats), c.getConversionStats);

router.get('/', requirePermission('enquiries.view'), validate(v.listEnquiries), c.getEnquiries);
router.post('/', requirePermission('enquiries.create'), validate(v.createEnquiry), c.createEnquiry);
router.get('/:id', requirePermission('enquiries.view'), validate(v.idParam), c.getEnquiryById);
router.put('/:id', requirePermission('enquiries.edit'), validate(v.updateEnquiry), c.updateEnquiry);
router.patch('/:id', requirePermission('enquiries.edit'), validate(v.updateEnquiry), c.updateEnquiry);
router.post('/:id/notes', requirePermission('enquiries.edit'), validate(v.addNote), c.addNote);
router.post('/:id/convert', requirePermission('enquiries.convert'), validate(v.convertEnquiry), c.convertEnquiry);
router.delete('/:id', requirePermission('enquiries.edit'), validate(v.idParam), c.deleteEnquiry);

module.exports = router;
