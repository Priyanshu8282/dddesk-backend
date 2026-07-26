const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('./src/modules/sidebar/sidebar.model');

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URL);
        console.log('Connected to DB');

        // Check if Banners already exists
        const existing = await SidebarMenu.findOne({ title: 'Banners' });
        if (existing) {
            console.log('Banners menu already exists.');
            return;
        }

        const bannerMenu = new SidebarMenu({
            title: 'Banners',
            to: '/banners/list-banners',
            iconStyle: '<i className="la la-image"></i>', // Typical icon format
            parent_module_id: '-1', // Top level
            module_id: 'banners_' + Date.now(),
            userType: 'admin',
            hasMenu: false
        });

        await bannerMenu.save();
        console.log('Successfully inserted Banners menu');
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
