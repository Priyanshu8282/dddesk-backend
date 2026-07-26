const express = require('express');
const router = express.Router();
const visitorController = require('./visitor.controller');

// Public — no auth needed
router.post('/visit', visitorController.recordVisit);
router.post('/ping', visitorController.heartbeatPing);

module.exports = router;
