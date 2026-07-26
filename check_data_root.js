const mongoose = require('mongoose');
const Admin = require('./src/modules/admins/admin.model');
const Library = require('./src/modules/libraries/library.model');
require('dotenv').config();

const checkDB = async () => {
    try {
        const url = 'mongodb+srv://mgi_basket:76IcLMwawjgs89la@cluster0.iww448g.mongodb.net/lms?retryWrites=true&w=majority';
        await mongoose.connect(url);
        console.log('Connected to MongoDB');

        const admins = await Admin.find({});
        console.log('Total Admins:', admins.length);
        admins.forEach(a => console.log(`Admin: ${a.email}, userType: ${a.userType}, isDeleted: ${a.isDeleted}`));

        const libraries = await Library.find({});
        console.log('Total Libraries:', libraries.length);
        libraries.forEach(l => console.log(`Library: ${l.name}, isDeleted: ${l.isDeleted}`));

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

checkDB();
