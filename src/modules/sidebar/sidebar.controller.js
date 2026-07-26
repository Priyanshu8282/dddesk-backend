const SidebarMenu = require('./sidebar.model');

exports.createSidebarMenu = async (req, res) => {
    try {
        const menu = await SidebarMenu.create(req.body);
        res.status(201).json(menu);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getSidebarMenus = async (req, res) => {
    try {
        if (req.userType === 'student') {
            const menus = await SidebarMenu.find({ userType: 'student' }).sort({ module_priority: 1, module_menu_priority: 1 });
            return res.json(menus);
        }

        const admin = req.user;

        if (admin.userType === 'superadmin') {
            const menus = await SidebarMenu.find({ 
                userType: { $nin: ['student'] },
                title: { $nin: ['Role Management', 'Access Control'] }
            }).sort({ module_priority: 1, module_menu_priority: 1 });
            return res.json(menus);
        }

        if (admin.userType === 'admin') {
            const menus = await SidebarMenu.find({ 
                userType: { $nin: ['student'] },
                title: { $nin: ['Libraries', 'Library Management'] }
            }).sort({ module_priority: 1, module_menu_priority: 1 });
            return res.json(menus);
        }

        await admin.populate('roleId');
        if (!admin.roleId) {
            return res.json([]);
        }

        const menus = await SidebarMenu.find({
            _id: { $in: admin.roleId.sidebarMenuIds }
        }).sort({ module_priority: 1, module_menu_priority: 1 });

        res.json(menus);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getAllSidebarMenus = async (req, res) => {
    try {
        const menus = await SidebarMenu.find().sort({ module_priority: 1, module_menu_priority: 1 });
        res.json(menus);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateSidebarMenu = async (req, res) => {
    try {
        const menu = await SidebarMenu.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(menu);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteSidebarMenu = async (req, res) => {
    try {
        const Role = require('../roles/role.model');
        const roleUsingMenu = await Role.findOne({ sidebarMenuIds: req.params.id });
        
        if (roleUsingMenu) {
            return res.status(400).json({ 
                message: `Cannot delete menu item. It is currently assigned to the '${roleUsingMenu.name}' role.` 
            });
        }

        const deletedMenu = await SidebarMenu.findByIdAndDelete(req.params.id);
        if (!deletedMenu) {
            return res.status(404).json({ message: 'Menu item not found' });
        }
        res.json({ message: 'Menu item deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
