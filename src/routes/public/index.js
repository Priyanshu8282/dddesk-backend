const express = require('express');
const authRoutes = require('./auth.routes');
const websiteRoutes = require('./website.routes');

const router = express.Router();

// Mount public auth & registration directly at /v1/public (e.g. /v1/public/login)
router.use('/', authRoutes);

// Mount public website dynamic profile routes (e.g. /v1/public/website/:slug)
router.use('/website', websiteRoutes);

module.exports = router;
