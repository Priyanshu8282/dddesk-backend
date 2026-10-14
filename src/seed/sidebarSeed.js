require('dotenv').config();
const mongoose = require('mongoose');
const SidebarMenu = require('../models/sidebar.model');
const config = require('../config/config');

// Menus for the operational areas added after the first seed. Upserted by (title, parent_module_id, userType),
// so running it repeatedly never duplicates or deletes anything. priorities are numeric strings.
const MENUS = [
  { title: 'Operations', classChange: 'menu-title', module_id: '30', module_priority: '3', userType: 'admin' },
  { title: 'Seats', iconStyle: "<i className='la la-chair' />", parent_module_id: '30', module_menu_priority: '1', userType: 'admin', to: 'seats' },
  { title: 'Attendance', iconStyle: "<i className='la la-calendar-check' />", parent_module_id: '30', module_menu_priority: '2', userType: 'admin', to: 'attendance' },
  { title: 'Enquiries', iconStyle: "<i className='la la-question-circle' />", parent_module_id: '30', module_menu_priority: '3', userType: 'admin', to: 'enquiries' },
  { title: 'Complaints', iconStyle: "<i className='la la-exclamation-circle' />", parent_module_id: '30', module_menu_priority: '4', userType: 'admin', to: 'complaints' },

  { title: 'Finance', classChange: 'menu-title', module_id: '31', module_priority: '8', userType: 'admin' },
  { title: 'Fees & Payments', iconStyle: "<i className='la la-rupee-sign' />", parent_module_id: '31', module_menu_priority: '1', userType: 'admin', to: 'payments' },
  { title: 'Expenses', iconStyle: "<i className='la la-wallet' />", parent_module_id: '31', module_menu_priority: '2', userType: 'admin', to: 'expenses' },
  { title: 'Reports', iconStyle: "<i className='la la-chart-bar' />", parent_module_id: '31', module_menu_priority: '3', userType: 'admin', to: 'reports' },

  { title: 'Content', classChange: 'menu-title', module_id: '32', module_priority: '9', userType: 'admin' },
  { title: 'Notices', iconStyle: "<i className='la la-bullhorn' />", parent_module_id: '32', module_menu_priority: '1', userType: 'admin', to: 'notices' },
  { title: 'Stories', iconStyle: "<i className='la la-images' />", parent_module_id: '32', module_menu_priority: '2', userType: 'admin', to: 'stories' },
  { title: 'Banners', iconStyle: "<i className='la la-image' />", parent_module_id: '32', module_menu_priority: '3', userType: 'admin', to: 'banners' },

  { title: 'Settings', classChange: 'menu-title', module_id: '33', module_priority: '10', userType: 'admin' },
  { title: 'Library Profile', iconStyle: "<i className='la la-cog' />", parent_module_id: '33', module_menu_priority: '1', userType: 'admin', to: 'settings/profile' },
  { title: 'Branches', iconStyle: "<i className='la la-code-branch' />", parent_module_id: '33', module_menu_priority: '2', userType: 'admin', to: 'branches' },
  { title: 'Audit Log', iconStyle: "<i className='la la-history' />", parent_module_id: '33', module_menu_priority: '3', userType: 'admin', to: 'settings/audit-logs' },
];

const seedSidebar = async () => {
  let created = 0;
  for (const m of MENUS) {
    const res = await SidebarMenu.updateOne(
      { title: m.title, parent_module_id: m.parent_module_id || '-1', userType: m.userType },
      { $setOnInsert: m },
      { upsert: true }
    );
    if (res.upsertedCount) created += 1;
  }
  return { created, total: MENUS.length };
};

module.exports = { seedSidebar, MENUS };

if (require.main === module) {
  (async () => {
    try {
      await mongoose.connect(config.mongoose.url);
      const r = await seedSidebar();
      console.log(`Sidebar seed done: ${r.created} new of ${r.total}. Run seed/rbacSync.js to attach menus to the Super Admin role.`);
      process.exit(0);
    } catch (e) {
      console.error('Sidebar seed failed:', e);
      process.exit(1);
    }
  })();
}
