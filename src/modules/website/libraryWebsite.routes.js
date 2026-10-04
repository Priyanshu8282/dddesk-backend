const express = require('express');
const router = express.Router();
const ctrl = require('./libraryWebsite.controller');
const Authentication = require('../../middlewares/auth.middleware');

router.get('/settings', Authentication, ctrl.getSettings);
router.put('/settings', Authentication, ctrl.updateSettings);

module.exports = router;
