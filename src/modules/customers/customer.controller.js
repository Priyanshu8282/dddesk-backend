const Customer = require('./customer.model');
const Wallet = require('../wallet/wallet.model');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const config = require('../../config/config');

// Generate a 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

exports.sendOTP = async (req, res) => {
    try {
        const { phone, countryCode = '+91' } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

        // Check if customer exists first
        const existing = await Customer.findOne({ phone });
        const isNewUser = !existing;

        await Customer.findOneAndUpdate(
            { phone },
            { phone, countryCode, otp, otpExpiry },
            { upsert: true, new: true }
        );

        // In production: send OTP via SMS provider
        console.log(`🔐 OTP for ${phone}: ${otp}`);

        res.json({ success: true, message: 'OTP sent successfully', otp, phone, isNewUser });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.verifyOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required' });

        const customer = await Customer.findOne({ phone });
        if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
        if (customer.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
        if (new Date() > customer.otpExpiry) return res.status(400).json({ success: false, message: 'OTP expired' });

        // Clear OTP and update lastLogin
        customer.otp = null;
        customer.otpExpiry = null;
        customer.lastLogin = new Date();
        await customer.save();

        // Create Wallet if it doesn't exist
        const existingWallet = await Wallet.findOne({ customerId: customer._id });
        if (!existingWallet) {
            await Wallet.create({ customerId: customer._id, balance: 0, status: 'active' });
        }

        const token = jwt.sign(
            { _id: customer._id, phone: customer.phone, userType: 'customer' },
            config.jwt.secret || 'mgibasket_secret',
            { expiresIn: '30d' }
        );

        res.json({ success: true, message: 'Login successful', token, customer });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const customer = await Customer.findById(req.customer._id).select('-otp -otpExpiry');
        if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
        res.json({ success: true, customer });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.logout = async (req, res) => {
    try {
        // Here we could implement token blacklisting if needed
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name, email } = req.body;
        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (email !== undefined) updateData.email = email;

        // Handle profile image upload
        if (req.file) {
            // Delete old image if exists
            const oldCustomer = await Customer.findById(req.customer._id);
            if (oldCustomer?.profileImage) {
                const oldPath = path.join(process.cwd(), oldCustomer.profileImage);
                if (fs.existsSync(oldPath)) {
                    try { fs.unlinkSync(oldPath); } catch (e) { /* ignore */ }
                }
            }
            updateData.profileImage = req.file.path.replace(/\\/g, '/');
        }

        const customer = await Customer.findByIdAndUpdate(
            req.customer._id,
            updateData,
            { new: true, runValidators: true }
        ).select('-otp -otpExpiry');

        res.json({ success: true, customer });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.addAddress = async (req, res) => {
    try {
        const customer = await Customer.findById(req.customer._id);

        if (customer.savedAddresses.length >= 5) {
            return res.status(400).json({ success: false, message: 'You can only save up to 5 addresses.' });
        }

        const address = req.body;
        if (address.isDefault) {
            customer.savedAddresses.forEach(a => a.isDefault = false);
        }
        customer.savedAddresses.push(address);
        await customer.save();
        res.json({ success: true, savedAddresses: customer.savedAddresses });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.updateAddress = async (req, res) => {
    try {
        const customer = await Customer.findById(req.customer._id);
        const addr = customer.savedAddresses.id(req.params.addressId);
        if (!addr) return res.status(404).json({ success: false, message: 'Address not found' });
        if (req.body.isDefault) {
            customer.savedAddresses.forEach(a => a.isDefault = false);
        }
        Object.assign(addr, req.body);
        await customer.save();
        res.json({ success: true, savedAddresses: customer.savedAddresses });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.deleteAddress = async (req, res) => {
    try {
        const customer = await Customer.findById(req.customer._id);
        customer.savedAddresses = customer.savedAddresses.filter(a => a._id.toString() !== req.params.addressId);
        await customer.save();
        res.json({ success: true, savedAddresses: customer.savedAddresses });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};




exports.reverseGeocode = async (req, res) => {
    try {
        const { lat, lon, provider } = req.query;
        let url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`;

        if (provider === 'bigdatacloud') {
            url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
        }

        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.searchLocation = async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        const url = `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&limit=${limit}`;

        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
//=>
exports.updateLocation = async (req, res) => {
    try {
        const { address, latitude, longitude } = req.body;
        const customer = await Customer.findByIdAndUpdate(
            req.customer._id,
            {
                lastLocation: {
                    address,
                    lat: latitude,
                    lng: longitude
                }
            },
            { new: true }
        );
        res.json({ success: true, customer });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
