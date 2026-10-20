require('dotenv').config();
const mongoose = require('mongoose');
const SidebarMenu = require('../models/sidebar.model');
const Role = require('../models/role.model');

/**
 * The library owner / staff sidebar: one flat list, in the order a library actually works day to day.
 * `iconStyle` is an icon key the frontend maps to an icon; `to` is a /dashboard/<page> route that exists.
 */
const LIBRARY_MENUS = [
  { title: 'Dashboard', iconStyle: 'dashboard', to: '/dashboard' },
  { title: 'Students', iconStyle: 'students', to: 'students' },
  { title: 'Seats', iconStyle: 'seats', to: 'seats' },
  { title: 'Attendance', iconStyle: 'attendance', to: 'attendance' },
  { title: 'Enquiries', iconStyle: 'enquiries', to: 'enquiries' },
  { title: 'Plans', iconStyle: 'plans', to: 'plans' },
  { title: 'Fees & Payments', iconStyle: 'payments', to: 'payments' },
  { title: 'Expenses', iconStyle: 'expenses', to: 'expenses' },
  { title: 'Reports', iconStyle: 'reports', to: 'reports' },
  { title: 'Notices', iconStyle: 'notices', to: 'notices' },
  { title: 'Stories', iconStyle: 'stories', to: 'stories' },
  { title: 'Banners', iconStyle: 'banners', to: 'banners' },
  { title: 'Notifications', iconStyle: 'notifications', to: 'notifications' },
  { title: 'Staff', iconStyle: 'staff', to: 'staff' },
  { title: 'Roles & Access', iconStyle: 'roles', to: 'roles' },
  { title: 'Branches', iconStyle: 'branches', to: 'branches' },
  { title: 'Billing', iconStyle: 'billing', to: 'billing' },
  { title: 'Settings', iconStyle: 'settings', to: 'settings' },
];

// old menu title -> new title, so roles that had the old item keep the equivalent one
const TITLE_MAP = {
  Dashboard: 'Dashboard', Students: 'Students', Seats: 'Seats', Attendance: 'Attendance', '⏱ Attendance': 'Attendance',
  Enquiries: 'Enquiries', Plans: 'Plans', 'Fees & Payments': 'Fees & Payments', Transactions: 'Fees & Payments', '💰 Transactions': 'Fees & Payments',
  Expenses: 'Expenses', Reports: 'Reports', '📊 Reports': 'Reports', Notices: 'Notices', Stories: 'Stories', '📢 Stories': 'Stories',
  Banners: 'Banners', '🖼️ Banners': 'Banners', Notifications: 'Notifications', Employees: 'Staff', 'Role Management': 'Roles & Access',
  Branches: 'Branches', Settings: 'Settings', 'Library Profile': 'Settings',
};

/**
 * Makes the admin-type sidebar exactly LIBRARY_MENUS (in order). Menus already pointing at the same page are kept (same _id, so roles keep working);
 * the rest of the admin-type menus (group headings, Libraries, Database, duplicates...) are removed and taken off every role.
 * apply=false only reports what would change. Assumes an open connection.
 */
const syncLibrarySidebar = async ({ apply = false } = {}) => {
  const existing = await SidebarMenu.find({ userType: { $in: ['admin', 'library', 'staff', 'superadmin'] } }).lean();
  const norm = (to) => String(to || '').replace(/^\/?(dashboard\/)?/, '').replace(/\/.*$/, '') || 'dashboard';
  const keep = new Map(); // new title -> existing doc
  for (const m of existing) {
    if (!m.to) continue;
    const t = LIBRARY_MENUS.find((x) => norm(x.to) === norm(m.to));
    if (t && !keep.has(t.title)) keep.set(t.title, m);
  }
  const removeDocs = existing.filter((m) => ![...keep.values()].some((k) => String(k._id) === String(m._id)));
  const report = { keep: keep.size, create: LIBRARY_MENUS.length - keep.size, remove: removeDocs.map((m) => m.title) };
  if (!apply) return report;

  const idByTitle = new Map();
  for (let i = 0; i < LIBRARY_MENUS.length; i++) {
    const def = LIBRARY_MENUS[i];
    const doc = {
      title: def.title, iconStyle: def.iconStyle, to: def.to, userType: 'admin', parent_module_id: '1',
      module_id: undefined, module_priority: '1', module_menu_priority: String(i + 1), classChange: undefined, classsChange: undefined, hasMenu: false, content: [],
    };
    const old = keep.get(def.title);
    if (old) {
      await SidebarMenu.updateOne({ _id: old._id }, { $set: { title: doc.title, iconStyle: doc.iconStyle, to: doc.to, userType: 'admin', parent_module_id: '1', module_priority: '1', module_menu_priority: doc.module_menu_priority, hasMenu: false, content: [] }, $unset: { module_id: '', classChange: '', classsChange: '' } });
      idByTitle.set(def.title, old._id);
    } else {
      const created = await SidebarMenu.create(Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));
      idByTitle.set(def.title, created._id);
    }
  }

  const removedIds = new Set(removeDocs.map((m) => String(m._id)));
  const oldTitle = new Map(existing.map((m) => [String(m._id), m.title]));
  const roles = await Role.find({ sidebarMenuIds: { $exists: true, $ne: [] } }, 'name sidebarMenuIds libraryId');
  for (const role of roles) {
    const next = new Set();
    for (const id of role.sidebarMenuIds.map(String)) {
      if (!removedIds.has(id)) { next.add(id); continue; }
      const mapped = TITLE_MAP[oldTitle.get(id)];
      if (mapped && idByTitle.get(mapped)) next.add(String(idByTitle.get(mapped)));
    }
    if (role.name === 'Super Admin' && !role.libraryId) idByTitle.forEach((v) => next.add(String(v)));
    role.sidebarMenuIds = [...next];
    await role.save();
  }
  if (removeDocs.length) await SidebarMenu.deleteMany({ _id: { $in: removeDocs.map((m) => m._id) } });
  return { ...report, roles: roles.length };
};

module.exports = { LIBRARY_MENUS, syncLibrarySidebar };

if (require.main === module) {
  (async () => {
    try {
      await mongoose.connect(require('../config/config').mongoose.url);
      const apply = process.argv.includes('--apply');
      const r = await syncLibrarySidebar({ apply });
      console.log(apply ? 'Sidebar updated:' : 'DRY RUN (add --apply to change the database):', JSON.stringify(r, null, 2));
      process.exit(0);
    } catch (e) { console.error('Sidebar sync failed:', e); process.exit(1); }
  })();
}
