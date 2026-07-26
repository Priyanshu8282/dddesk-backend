const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVars = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 5005,
    MONGODB_URL: process.env.MONGODB_URL || process.env.MONGODB_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_EXPIRATION: process.env.JWT_EXPIRATION || '24h'
};

const { NODE_ENV, PORT, MONGODB_URL } = envVars;

// MongoDB configuration
const mongooseConfig = {
    url: MONGODB_URL + (NODE_ENV === 'test' ? '-test' : ''),
};

const config = {
    env: NODE_ENV,
    port: PORT,
    mongoose: mongooseConfig,
    jwt: {
        secret: envVars.JWT_SECRET,
        expiration: envVars.JWT_EXPIRATION,
    },
};

module.exports = config;
