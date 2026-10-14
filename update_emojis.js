const mongoose = require('mongoose');
const SidebarMenu = require('./src/models/sidebar.model');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/MgiBasket');
        console.log('Connected to DB');

        await SidebarMenu.updateOne({ title: 'Transactions' }, { title: '💰 Transactions' });
        await SidebarMenu.updateOne({ title: 'Attendance' }, { title: '⏱ Attendance' });
        await SidebarMenu.updateOne({ title: 'Stories' }, { title: '📢 Stories' });
        await SidebarMenu.updateOne({ title: 'Notifications' }, { title: '🔔 Notifications' });
        await SidebarMenu.updateOne({ title: 'Reports' }, { title: '📊 Reports' });
        
        console.log('Updated titles with emojis');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
