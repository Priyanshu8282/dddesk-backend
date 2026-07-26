const Subcategory = require('./subcategory.model');
const fs = require('fs');

exports.createSubcategory = async (req, res) => {
    try {
        const subcategoryData = { ...req.body };
        if (req.file) {
            subcategoryData.image = req.file.path;
        }

        if (req.body.masterCategory) {
            subcategoryData.masterCategory = req.body.masterCategory;
        }

        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const subcategory = new Subcategory({
            ...subcategoryData,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });

        await subcategory.save();
        res.status(201).json({ success: true, subcategory });
    } catch (error) {
        if (req.file) {
            fs.unlink(req.file.path, () => { });
        }
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getSubcategories = async (req, res) => {
    try {
        const query = { isDeleted: false };
        // Optional search by name
        if (req.query.search) {
            query.name = { $regex: req.query.search, $options: 'i' };
        }
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }

        const subcategories = await Subcategory.find(query)
            .sort({ order: 1, createdAt: -1 })
            .populate('categoryId', 'name image')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' });

        res.json({ success: true, subcategories });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getSubcategoryById = async (req, res) => {
    try {
        const subcategory = await Subcategory.findById(req.params.id)
            .populate('categoryId', 'name')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' });
        if (!subcategory || subcategory.isDeleted) return res.status(404).json({ success: false, message: 'Subcategory not found' });
        res.json({ success: true, subcategory });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateSubcategory = async (req, res) => {
    try {
        const subcategoryData = { ...req.body };

        if (req.file) {
            subcategoryData.image = req.file.path;
        } else if (req.body.removeImage === 'true') {
            subcategoryData.image = null;
        }
        delete subcategoryData.removeImage;

        if (req.body.masterCategory) {
            subcategoryData.masterCategory = req.body.masterCategory;
        }

        const subcategory = await Subcategory.findByIdAndUpdate(req.params.id,
            { ...subcategoryData, updatedBy: req.user?._id },
            { new: true }
        ).populate('categoryId', 'name image');

        if (!subcategory) return res.status(404).json({ success: false, message: 'Subcategory not found' });
        res.json({ success: true, subcategory });
    } catch (error) {
        if (req.file) {
            fs.unlink(req.file.path, () => { });
        }
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateSubcategoryStatus = async (req, res) => {
    try {
        const subcategory = await Subcategory.findByIdAndUpdate(
            req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        if (!subcategory) return res.status(404).json({ success: false, message: 'Subcategory not found' });
        res.json({ success: true, subcategory });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteSubcategory = async (req, res) => {
    try {
        const subcategory = await Subcategory.findByIdAndUpdate(req.params.id,
            { isDeleted: true, updatedBy: req.user?._id },
            { new: true }
        );
        if (!subcategory) return res.status(404).json({ success: false, message: 'Subcategory not found' });
        res.json({ success: true, message: 'Subcategory deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
