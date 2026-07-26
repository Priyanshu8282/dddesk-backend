const Unit = require('./unit.model');

exports.createUnit = async (req, res) => {
    try {
        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const unit = await Unit.create({
            ...req.body,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, unit });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getUnits = async (req, res) => {
    try {
        const query = { isDeleted: false };
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }
        const units = await Unit.find(query)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 });
        res.json({ success: true, units });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateUnit = async (req, res) => {
    try {
        const unit = await Unit.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });
        res.json({ success: true, unit });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteUnit = async (req, res) => {
    try {
        const unit = await Unit.findById(req.params.id);
        if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });

        unit.isDeleted = true;
        await unit.save();

        res.json({ success: true, message: 'Unit deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateUnitStatus = async (req, res) => {
    try {
        const unit = await Unit.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, unit });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

