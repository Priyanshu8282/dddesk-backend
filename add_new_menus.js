const mongoose = require('mongoose');
const SidebarMenu = require('./src/modules/sidebar/sidebar.model');
const Role = require('./src/modules/roles/role.model');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/MgiBasket');
        console.log('Connected to DB');

        const newMenus = [
            { title: 'Transactions', iconStyle: "<i className='la la-money'></i>", to: 'transactions', parent_module_id: '-1', hasMenu: false, userType: 'admin', module_menu_priority: '2' },
            { title: 'Attendance', iconStyle: "<i className='la la-clock-o'></i>", to: 'attendance', parent_module_id: '-1', hasMenu: false, userType: 'admin', module_menu_priority: '3' },
            { title: 'Stories', iconStyle: "<i className='la la-bullhorn'></i>", to: 'stories', parent_module_id: '-1', hasMenu: false, userType: 'admin', module_menu_priority: '4' },
            { title: 'Notifications', iconStyle: "<i className='la la-bell'></i>", to: 'notifications', parent_module_id: '-1', hasMenu: false, userType: 'admin', module_menu_priority: '5' },
            { title: 'Reports', iconStyle: "<i className='la la-bar-chart'></i>", to: 'reports', parent_module_id: '-1', hasMenu: false, userType: 'admin', module_menu_priority: '6' }
        ];

        // check if they already exist
        for (const menu of newMenus) {
            const exists = await SidebarMenu.findOne({ title: menu.title });
            if (!exists) {
                const created = await SidebarMenu.create(menu);
                console.log(`Created menu: ${menu.title}`);
                // add to admin and super admin roles
                await Role.updateMany(
                    { name: { $in: ['Admin', 'Super Admin'] } },
                    { $addToSet: { sidebarMenuIds: created._id } }
                );
            } else {
                console.log(`Menu ${menu.title} already exists.`);
                await Role.updateMany(
                    { name: { $in: ['Admin', 'Super Admin'] } },
                    { $addToSet: { sidebarMenuIds: exists._id } }
                );
            }
        }
        
        console.log('Done');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
