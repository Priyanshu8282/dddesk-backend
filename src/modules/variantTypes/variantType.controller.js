const VariantType = require('./variantType.model');

exports.createVariantType = async (req, res) => {
    try {
        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const variantType = await VariantType.create({
            ...req.body,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, variantType });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getVariantTypes = async (req, res) => {
    try {
        const query = { isDeleted: false };
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }
        const variantTypes = await VariantType.find(query)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 });
        res.json({ success: true, variantTypes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateVariantType = async (req, res) => {
    try {
        const variantType = await VariantType.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        if (!variantType) return res.status(404).json({ success: false, message: 'Variant Attribute not found' });
        res.json({ success: true, variantType });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteVariantType = async (req, res) => {
    try {
        const variantType = await VariantType.findById(req.params.id);
        if (!variantType) return res.status(404).json({ success: false, message: 'Variant Attribute not found' });

        variantType.isDeleted = true;
        await variantType.save();

        res.json({ success: true, message: 'Variant Attribute deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateVariantTypeStatus = async (req, res) => {
    try {
        const variantType = await VariantType.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, variantType });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

