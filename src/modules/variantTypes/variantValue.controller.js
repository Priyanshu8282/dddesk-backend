const VariantValue = require('./variantValue.model');

exports.createVariantValue = async (req, res) => {
    try {
        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const variantValue = await VariantValue.create({
            ...req.body,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, variantValue });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getVariantValues = async (req, res) => {
    try {
        const filter = { isDeleted: false };
        if (req.query.variantTypeId) {
            filter.variantTypeId = req.query.variantTypeId;
        }
        if (req.query.masterCategory) {
            filter.masterCategory = req.query.masterCategory;
        }
        const variantValues = await VariantValue.find(filter)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ sortOrder: 1, createdAt: -1 });
        res.json({ success: true, variantValues });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateVariantValue = async (req, res) => {
    try {
        const variantValue = await VariantValue.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        if (!variantValue) return res.status(404).json({ success: false, message: 'Variant Value not found' });
        res.json({ success: true, variantValue });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateVariantValueStatus = async (req, res) => {
    try {
        const variantValue = await VariantValue.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, variantValue });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteVariantValue = async (req, res) => {
    try {
        const variantValue = await VariantValue.findById(req.params.id);
        if (!variantValue) return res.status(404).json({ success: false, message: 'Variant Value not found' });

        variantValue.isDeleted = true;
        await variantValue.save();

        res.json({ success: true, message: 'Variant Value deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
