const jwt = require('jsonwebtoken');
const Customer = require('../modules/customers/customer.model');
const config = require('../config/config');

const customerAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, config.jwt.secret || 'mgibasket_secret');
        if (decoded.userType !== 'customer') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        const customer = await Customer.findById(decoded._id).select('-otp -otpExpiry');
        if (!customer || !customer.isActive) {
            return res.status(401).json({ success: false, message: 'Customer account not found or inactive' });
        }
        req.customer = customer;
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

module.exports = customerAuth;
