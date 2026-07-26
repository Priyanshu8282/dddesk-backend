const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('./src/modules/sidebar/sidebar.model');

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URL);
        console.log('Connected to DB');

        const banners = await SidebarMenu.findOne({ title: { $regex: /Banners/i } });
        if (banners) {
            banners.title = '🖼️ Banners';
            banners.iconStyle = "<i className='la la-image'></i>";
            await banners.save();
            console.log('Updated Banners title and iconStyle');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
