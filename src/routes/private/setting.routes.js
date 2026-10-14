const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/setting.controller');

router.get('/',       ctrl.getSettings);
router.get('/:key',   ctrl.getSettings);
router.post('/',      ctrl.updateSetting);
router.put('/:key',   ctrl.updateSetting);

module.exports = router;
