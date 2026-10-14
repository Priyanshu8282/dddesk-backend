const express = require('express');
const publicRoutes = require('./public');
const privateRoutes = require('./private');

const router = express.Router();

router.use('/public', publicRoutes);
router.use('/private', privateRoutes);

module.exports = {
    publicRoutes,
    privateRoutes,
    router
};
