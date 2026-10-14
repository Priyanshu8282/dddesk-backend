const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/libraryWebsite.controller');

router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

module.exports = router;
