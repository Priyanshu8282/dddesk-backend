const express = require('express');
const router = express.Router();
const addonController = require('./addon.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

router.post('/create-addon', Authentication, Authorization, addonController.createAddon);
router.get('/get-addons', Authentication, addonController.getAddons);
router.put('/update-addon/:id', Authentication, Authorization, addonController.updateAddon);
router.delete('/delete-addon/:id', Authentication, Authorization, addonController.deleteAddon);

module.exports = router;
