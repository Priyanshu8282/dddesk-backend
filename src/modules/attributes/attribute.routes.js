const express = require('express');
const router = express.Router();
const attributeController = require('./attribute.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

router.post('/create-attribute', Authentication, Authorization, attributeController.createAttribute);
router.get('/get-attributes', Authentication, attributeController.getAttributes);
router.put('/update-attribute/:id', Authentication, Authorization, attributeController.updateAttribute);
router.delete('/delete-attribute/:id', Authentication, Authorization, attributeController.deleteAttribute);

module.exports = router;
