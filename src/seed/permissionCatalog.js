// Single source of truth for permission keys (spec section 12: permission groups).
// Legacy UPPER_CASE keys are kept so existing roles keep working; new keys use "<area>.<action>".

const P = (name, key, module, description, extra = {}) => ({ name, key, module, description, ...extra });

// Legacy keys (route is used by the legacy Authorization middleware)
const LEGACY = [
  { name: 'View Dashboard', key: 'VIEW_DASHBOARD', module: 'CORE', route: 'dashboard' },
  { name: 'View Employees', key: 'VIEW_ADMINS', module: 'EMPLOYEECONTROL', route: 'get-admins' },
  { name: 'Create Employee', key: 'CREATE_ADMIN', module: 'EMPLOYEECONTROL', route: 'create-admin' },
  { name: 'Update Employee', key: 'UPDATE_ADMIN', module: 'EMPLOYEECONTROL', route: 'update-admin' },
  { name: 'Delete Employee', key: 'DELETE_ADMIN', module: 'EMPLOYEECONTROL', route: 'delete-admin' },
  { name: 'View Roles', key: 'VIEW_ROLES', module: 'PERMISSIONCONTROL', route: 'get-roles' },
  { name: 'Create Role', key: 'CREATE_ROLE', module: 'PERMISSIONCONTROL', route: 'create-role' },
  { name: 'Update Role', key: 'UPDATE_ROLE', module: 'PERMISSIONCONTROL', route: 'update-role' },
  { name: 'Delete Role', key: 'DELETE_ROLE', module: 'PERMISSIONCONTROL', route: 'delete-role' },
  { name: 'View Permissions', key: 'VIEW_PERMISSIONS', module: 'PERMISSIONCONTROL', route: 'get-permissions' },
  { name: 'Create Permission', key: 'CREATE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'create-permission', scope: 'platform' },
  { name: 'Update Permission', key: 'UPDATE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'update-permission', scope: 'platform' },
  { name: 'Delete Permission', key: 'DELETE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'delete-permission', scope: 'platform' },
  { name: 'Manage Sidebar', key: 'MANAGE_SIDEBAR', module: 'SIDEBARCONTROL', route: 'create-menu', scope: 'platform' },
  { name: 'View Sidebar Menus', key: 'VIEW_SIDEBAR', module: 'SIDEBARCONTROL', route: 'get-menus' },
  { name: 'View Libraries', key: 'VIEW_LIBRARIES', module: 'LIBRARYCONTROL', route: 'get-libraries', scope: 'platform' },
  { name: 'Create Library', key: 'CREATE_LIBRARY', module: 'LIBRARYCONTROL', route: 'create-library', scope: 'platform' },
  { name: 'Update Library', key: 'UPDATE_LIBRARY', module: 'LIBRARYCONTROL', route: 'update-library' },
  { name: 'Delete Library', key: 'DELETE_LIBRARY', module: 'LIBRARYCONTROL', route: 'delete-library', scope: 'platform' },
  { name: 'View Students', key: 'VIEW_STUDENTS', module: 'STUDENTCONTROL', route: 'get-students' },
  { name: 'Create Student', key: 'CREATE_STUDENT', module: 'STUDENTCONTROL', route: 'create-student' },
  { name: 'Update Student', key: 'UPDATE_STUDENT', module: 'STUDENTCONTROL', route: 'update-student' },
  { name: 'Delete Student', key: 'DELETE_STUDENT', module: 'STUDENTCONTROL', route: 'delete-student' },
  { name: 'View Plans', key: 'VIEW_PLANS', module: 'PLANCONTROL', route: 'get-plans' },
  { name: 'Create Plan', key: 'CREATE_PLAN', module: 'PLANCONTROL', route: 'create-plan' },
  { name: 'Update Plan', key: 'UPDATE_PLAN', module: 'PLANCONTROL', route: 'update-plan' },
  { name: 'Delete Plan', key: 'DELETE_PLAN', module: 'PLANCONTROL', route: 'delete-plan' },
];

const GROUPS = [
  // Students: View, create, edit, archive
  P('View Students', 'students.view', 'STUDENTS', 'View student list and profiles'),
  P('Create Students', 'students.create', 'STUDENTS', 'Register / admit students'),
  P('Edit Students', 'students.edit', 'STUDENTS', 'Edit student profile, notes and status'),
  P('Archive Students', 'students.archive', 'STUDENTS', 'Archive / deactivate students without losing history'),
  P('Export Students', 'students.export', 'STUDENTS', 'Export student data'),
  // Seats: View, assign, transfer, block
  P('View Seats', 'seats.view', 'SEATS', 'View seat map and status'),
  P('Manage Seats', 'seats.manage', 'SEATS', 'Create / edit seats, floors and rooms'),
  P('Assign Seats', 'seats.assign', 'SEATS', 'Assign / release seats'),
  P('Transfer Seats', 'seats.transfer', 'SEATS', 'Transfer a student between seats'),
  P('Block Seats', 'seats.block', 'SEATS', 'Block seats / put under maintenance / reserve'),
  // Attendance: Check-in, check-out, corrections
  P('View Attendance', 'attendance.view', 'ATTENDANCE', 'View attendance records'),
  P('Attendance Check-in', 'attendance.checkin', 'ATTENDANCE', 'Mark student check-in'),
  P('Attendance Check-out', 'attendance.checkout', 'ATTENDANCE', 'Mark student check-out'),
  P('Attendance Corrections', 'attendance.correct', 'ATTENDANCE', 'Correct attendance records'),
  // Fees: View dues, collect payment, refund where allowed. fees.view = financial visibility.
  P('View Fees (Financial Visibility)', 'fees.view', 'FEES', 'See dues, payments, collections and financial figures'),
  P('Collect Fees', 'fees.collect', 'FEES', 'Collect payments and issue receipts'),
  P('Refund Fees', 'fees.refund', 'FEES', 'Refund or waive payments'),
  P('Adjust / Waive Fees', 'fees.adjust', 'FEES', 'Adjust, waive or cancel charges'),
  P('Allocate Payments', 'fees.allocate', 'FEES', 'Allocate a payment to specific dues (override oldest-first)'),
  P('Manage Offers', 'fees.offers', 'FEES', 'Manage coupons and offers'),
  // Expenses
  P('View Expenses', 'expenses.view', 'EXPENSES', 'View expenses'),
  P('Create Expenses', 'expenses.create', 'EXPENSES', 'Record expenses'),
  P('Manage Expenses', 'expenses.manage', 'EXPENSES', 'Create / edit expenses'),
  P('Delete Expenses', 'expenses.delete', 'EXPENSES', 'Delete expenses'),
  // Reports
  P('View Reports', 'reports.view', 'REPORTS', 'View selected reports'),
  P('Export Reports', 'reports.export', 'REPORTS', 'Export reports'),
  // Content: Create/publish stories, notices, banners
  P('View Content', 'content.view', 'CONTENT', 'View stories, notices and banners'),
  P('Create Content', 'content.create', 'CONTENT', 'Create stories, notices and banners'),
  P('Publish Content', 'content.publish', 'CONTENT', 'Publish / unpublish / delete content'),
  // Settings: Manage selected operational settings
  P('Manage Settings', 'settings.manage', 'SETTINGS', 'Manage library profile and operational settings'),
  P('Manage Branches', 'branches.manage', 'SETTINGS', 'Edit branch details'),
  P('Manage Website', 'website.manage', 'SETTINGS', 'Edit the public library website'),
  P('Manage Support Tickets', 'support.manage', 'SETTINGS', 'Create and reply to support tickets with the platform team'),
  P('Use AI Assistant', 'ai.use', 'AI', 'Use the AI owner assistant (answers are limited to data the user may see)'),
  // Enquiries
  P('View Enquiries', 'enquiries.view', 'ENQUIRIES', 'View enquiries'),
  P('Create Enquiries', 'enquiries.create', 'ENQUIRIES', 'Log enquiries'),
  P('Edit Enquiries', 'enquiries.edit', 'ENQUIRIES', 'Update enquiry status and notes'),
  P('Convert Enquiries', 'enquiries.convert', 'ENQUIRIES', 'Convert enquiry to student'),
  // Complaints
  P('View Complaints', 'complaints.view', 'COMPLAINTS', 'View complaints'),
  P('Assign Complaints', 'complaints.assign', 'COMPLAINTS', 'Assign complaints to staff'),
  P('Resolve Complaints', 'complaints.resolve', 'COMPLAINTS', 'Update / resolve / close complaints'),
  // Staff management
  P('View Staff', 'staff.view', 'STAFF', 'View staff accounts'),
  P('Create Staff', 'staff.create', 'STAFF', 'Create staff accounts'),
  P('Edit Staff', 'staff.edit', 'STAFF', 'Edit staff accounts and enable/disable'),
  P('Delete Staff', 'staff.delete', 'STAFF', 'Remove staff accounts'),
  P('Reset Staff Password', 'staff.reset_password', 'STAFF', 'Reset staff passwords'),
];

const ALL = [...LEGACY, ...GROUPS];

// Legacy UPPER_CASE keys and the dotted keys are two names for the same capability. Routes written against either
// name must work for roles built from either list, so req.permissions is expanded with both (see expandPermissions).
const ALIASES = {
  VIEW_STUDENTS: 'students.view', CREATE_STUDENT: 'students.create', UPDATE_STUDENT: 'students.edit', DELETE_STUDENT: 'students.archive',
  VIEW_ADMINS: 'staff.view', CREATE_ADMIN: 'staff.create', UPDATE_ADMIN: 'staff.edit', DELETE_ADMIN: 'staff.delete',
  UPDATE_LIBRARY: 'settings.manage', MANAGE_COUPONS: 'fees.offers',
};
const ALIAS_PAIRS = Object.entries(ALIASES);
const expandPermissions = (keys = []) => {
  const set = new Set(keys);
  for (const [legacy, dotted] of ALIAS_PAIRS) {
    if (set.has(legacy)) set.add(dotted);
    if (set.has(dotted)) set.add(legacy);
  }
  return [...set];
};

// Keys a tenant role may never hold (superadmin-only capabilities)
const PLATFORM_ONLY_KEYS = ALL.filter((p) => p.scope === 'platform').map((p) => p.key);

// Default permission sets for system role templates (libraryId = null)
const ROLE_TEMPLATES = {
  Staff: [
    'VIEW_DASHBOARD', 'VIEW_PLANS', 'students.view', 'students.create', 'students.edit', 'seats.view',
    'attendance.view', 'attendance.checkin', 'attendance.checkout',
    'enquiries.view', 'enquiries.create', 'complaints.view', 'content.view',
  ],
  Receptionist: [
    'VIEW_DASHBOARD', 'VIEW_PLANS', 'students.view', 'students.create', 'seats.view', 'seats.assign',
    'attendance.view', 'attendance.checkin', 'attendance.checkout',
    'enquiries.view', 'enquiries.create', 'enquiries.edit', 'complaints.view',
  ],
  Accountant: [
    'VIEW_DASHBOARD', 'VIEW_PLANS', 'students.view', 'fees.view', 'fees.collect', 'fees.allocate', 'reports.view', 'reports.export',
    'expenses.view', 'expenses.create', 'expenses.manage',
  ],
  Manager: [
    'VIEW_DASHBOARD', 'VIEW_PLANS', 'CREATE_PLAN', 'UPDATE_PLAN', 'students.view', 'students.create', 'students.edit', 'students.archive',
    'seats.view', 'seats.manage', 'seats.assign', 'seats.transfer', 'seats.block',
    'attendance.view', 'attendance.checkin', 'attendance.checkout', 'attendance.correct',
    'fees.view', 'fees.collect', 'fees.allocate', 'reports.view', 'reports.export', 'expenses.view', 'expenses.manage',
    'website.manage', 'ai.use', 'content.view', 'content.create', 'content.publish',
    'enquiries.view', 'enquiries.create', 'enquiries.edit', 'enquiries.convert',
    'complaints.view', 'complaints.assign', 'complaints.resolve',
  ],
};

// Sidebar menu titles each system role template starts with (menus are matched by title; owners/superadmin get all)
const MENU_BASE = ['Main Menu', 'Dashboard', 'Student Management', 'Students'];
const MENU_OPS = ['Operations', 'Seats', 'Attendance', 'Enquiries', 'Complaints'];
const MENU_CONTENT = ['Content', 'Notices', 'Stories', 'Banners'];
const MENU_FINANCE = ['Plan Management', 'Plans', 'Finance', 'Fees & Payments', 'Expenses', 'Reports'];
const ROLE_MENU_TITLES = {
  Staff: [...MENU_BASE, ...MENU_OPS, ...MENU_CONTENT],
  Receptionist: [...MENU_BASE, ...MENU_OPS, 'Plan Management', 'Plans'],
  Accountant: [...MENU_BASE, ...MENU_FINANCE],
  Manager: [...MENU_BASE, ...MENU_OPS, ...MENU_CONTENT, ...MENU_FINANCE],
};

module.exports = { ROLE_MENU_TITLES, LEGACY, GROUPS, ALL, ALIASES, expandPermissions, PLATFORM_ONLY_KEYS, ROLE_TEMPLATES };
