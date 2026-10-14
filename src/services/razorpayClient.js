// Single injectable Razorpay client (tests call __setClient with a mock).
const Razorpay = require('razorpay');
const ApiError = require('../utils/ApiError');

let _client = null;
let _override = null;

const getClient = () => {
    if (_override) return _override;
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new ApiError(503, 'Online payments are not configured');
    }
    if (!_client) _client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    return _client;
};

/** Test hook: pass a stub client, or null to restore the real one. */
const __setClient = (c) => { _override = c || null; };

module.exports = { getClient, __setClient };
