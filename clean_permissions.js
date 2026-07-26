const mongoose = require('mongoose');
require('dotenv').config();
const Permission = require('./src/modules/permissions/permission.model');
const config = require('./src/config/config');

async function cleanPermissions() {
    try {
        const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017/lms';
        await mongoose.connect(mongoUrl);
        
        console.log('Connected to DB. Finding CORE permissions...');
        
        const corePermissions = await Permission.find({ module: { $regex: /core/i } });
        console.log('Found core permissions:', corePermissions.map(p => p.name));
        
        const deleteResult = await Permission.deleteMany({ module: { $regex: /core/i } });
        console.log('Deleted CORE permissions:', deleteResult.deletedCount);
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

cleanPermissions();
