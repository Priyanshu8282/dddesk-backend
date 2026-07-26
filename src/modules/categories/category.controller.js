const Category = require('./category.model');

exports.createCategory = async (req, res) => {
    try {
        const categoryData = { ...req.body };
        if (req.file) {
            categoryData.image = req.file.path;
        }

        if (req.body.masterCategory) {
            categoryData.masterCategory = req.body.masterCategory;
        }

        // Normalize array fields from FormData
        if (req.body['attributeIds[]']) {
            categoryData.attributeIds = Array.isArray(req.body['attributeIds[]']) ? req.body['attributeIds[]'] : [req.body['attributeIds[]']];
        }
        if (req.body['variantTypeIds[]']) {
            categoryData.variantTypeIds = Array.isArray(req.body['variantTypeIds[]']) ? req.body['variantTypeIds[]'] : [req.body['variantTypeIds[]']];
        }
        if (req.body['addonIds[]']) {
            categoryData.addonIds = Array.isArray(req.body['addonIds[]']) ? req.body['addonIds[]'] : [req.body['addonIds[]']];
        }

        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const category = await Category.create({
            ...categoryData,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getCategories = async (req, res) => {
    try {
        const query = { isDeleted: false };
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }

        const categories = await Category.find(query)
            .populate('attributeIds')
            .populate('variantTypeIds')
            .populate('addonIds')
            .populate('parentId')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 }); // Show newest first
        res.json({ success: true, categories });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getCategoryById = async (req, res) => {
    try {
        const category = await Category.findById(req.params.id)
            .populate('attributeIds')
            .populate('variantTypeIds')
            .populate('addonIds')
            .populate('parentId')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' });
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, category });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const categoryData = { ...req.body };
        if (req.file) {
            categoryData.image = req.file.path;
        } else if (req.body.removeImage === 'true') {
            categoryData.image = null;
        }
        delete categoryData.removeImage;

        if (req.body.masterCategory) {
            categoryData.masterCategory = req.body.masterCategory;
        }

        // Normalize array fields from FormData
        if (req.body['attributeIds[]']) {
            categoryData.attributeIds = Array.isArray(req.body['attributeIds[]']) ? req.body['attributeIds[]'] : [req.body['attributeIds[]']];
        } else if (req.body.attributeIds === undefined) {
            // If not provided in form data at all, we might want to keep or clear depending on front-end logic.
            // Usually if it's not in req.body, it means we're not touching it or it was empty.
        }

        if (req.body['variantTypeIds[]']) {
            categoryData.variantTypeIds = Array.isArray(req.body['variantTypeIds[]']) ? req.body['variantTypeIds[]'] : [req.body['variantTypeIds[]']];
        }
        if (req.body['addonIds[]']) {
            categoryData.addonIds = Array.isArray(req.body['addonIds[]']) ? req.body['addonIds[]'] : [req.body['addonIds[]']];
        }

        const category = await Category.findByIdAndUpdate(req.params.id,
            { ...categoryData, updatedBy: req.user?._id },
            { new: true }
        );
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

        category.isDeleted = true;
        await category.save();

        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateCategoryStatus = async (req, res) => {
    try {
        const category = await Category.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, category });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const fs = require('fs');
const path = require('path');

exports.getPublicCategoryImage = async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category || !category.image) {
            return res.status(404).json({ message: 'Image not found' });
        }

        const imagePath = path.join(__dirname, '../../../../', category.image);
        if (fs.existsSync(imagePath)) {
            res.sendFile(imagePath);
        } else {
            res.status(404).json({ message: 'Image file not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
