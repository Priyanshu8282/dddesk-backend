const express = require('express');
const settingController = require('./setting.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

const router = express.Router();

router.get('/', Authentication, Authorization, settingController.getSettings);
router.post('/', Authentication, Authorization, settingController.updateSetting);

module.exports = router;
