const express = require('express');
const ctrl = require('../../controllers/libraryWebsite.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { websiteValidation } = require('../../validations');

const router = express.Router();

// Students never reach these routes
router.use(requireStaff);
const canManage = requirePermission('settings.manage', 'website.manage');

router.get('/settings', canManage, ctrl.getSettings);
router.put('/settings', canManage, validate(websiteValidation.updateSettings), ctrl.updateSettings);

module.exports = router;
