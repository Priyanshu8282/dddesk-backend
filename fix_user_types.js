const mongoose = require('mongoose');
const Admin = require('./src/models/admin.model');
require('dotenv').config();

const updateData = async () => {
    try {
        const url = 'mongodb+srv://mgi_basket:76IcLMwawjgs89la@cluster0.iww448g.mongodb.net/lms?retryWrites=true&w=majority';
        await mongoose.connect(url);
        console.log('Connected to MongoDB');

        // 1. Update admin@gmail.com to superadmin
        const res1 = await Admin.updateOne(
            { email: 'admin@gmail.com' },
            { $set: { userType: 'superadmin' } }
        );
        console.log('Updated admin@gmail.com to superadmin:', res1.modifiedCount);

        // 2. Update library_admin to admin
        const res2 = await Admin.updateMany(
            { userType: 'library_admin' },
            { $set: { userType: 'admin' } }
        );
        console.log('Updated library_admin to admin count:', res2.modifiedCount);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

updateData();
