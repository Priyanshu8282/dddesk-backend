const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/setting.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');

// Platform-wide settings: readable by any authenticated account (public keys only), writable by superadmin only
router.get('/',       ctrl.getSettings);
router.get('/:key',   ctrl.getSettings);
router.post('/',      requireSuperAdmin, validate(v.upsertSetting), ctrl.updateSetting);
router.put('/:key',   requireSuperAdmin, validate(v.upsertSetting), ctrl.updateSetting);

module.exports = router;
