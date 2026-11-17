const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('../src/models/sidebar.model');

const rearrangeSidebar = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/MgiBasket');
        console.log('Connected to MongoDB');

        // Define Priority Map
        const prioritySettings = [
            { module_id: 'main_menu', priority: '10' },
            { module_id: 'library_mgmt', priority: '20' },
            { module_id: 'emp_mgmt', priority: '30' },
            { module_id: 'access_ctrl', priority: '40' },
            { module_id: 'vendor_mgmt', priority: '50' },
        ];

        for (const setting of prioritySettings) {
            // Update the title section (header)
            await SidebarMenu.updateMany(
                { module_id: setting.module_id },
                { $set: { module_priority: setting.priority } }
            );

            // Update the children items
            await SidebarMenu.updateMany(
                { parent_module_id: setting.module_id },
                { $set: { module_priority: setting.priority } }
            );
        }

        console.log('Sidebar rearrangement (priority update) completed.');
        process.exit(0);
    } catch (error) {
        console.error('Error rearranging sidebar:', error);
        process.exit(1);
    }
};

rearrangeSidebar();
