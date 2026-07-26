const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('./src/modules/sidebar/sidebar.model');

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URL);
        console.log('Connected to DB');

        const stories = await SidebarMenu.findOne({ title: { $regex: /Stories/i } });
        console.log('Stories:', stories.title, 'iconStyle:', stories.iconStyle);

        const banners = await SidebarMenu.findOne({ title: { $regex: /Banners/i } });
        console.log('Banners:', banners.title, 'iconStyle:', banners.iconStyle);

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
