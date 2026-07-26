const Tax = require('./tax.model');

exports.createTax = async (req, res) => {
    try {
        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const tax = await Tax.create({
            ...req.body,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, tax });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getTaxes = async (req, res) => {
    try {
        const query = { isDeleted: false };
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }
        const taxes = await Tax.find(query)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 });
        res.json({ success: true, taxes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateTax = async (req, res) => {
    try {
        const tax = await Tax.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        if (!tax) return res.status(404).json({ success: false, message: 'Tax not found' });
        res.json({ success: true, tax });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateTaxStatus = async (req, res) => {
    try {
        const tax = await Tax.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, tax });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteTax = async (req, res) => {
    try {
        const tax = await Tax.findById(req.params.id);
        if (!tax) return res.status(404).json({ success: false, message: 'Tax not found' });

        tax.isDeleted = true;
        await tax.save();

        res.json({ success: true, message: 'Tax deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
