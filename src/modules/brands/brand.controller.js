const Brand = require('./brand.model');
const fs = require('fs');
const path = require('path');

exports.createBrand = async (req, res) => {
    try {
        const brandData = { ...req.body };
        if (req.file) {
            brandData.logo = req.file.path;
        }

        if (req.body.masterCategory) {
            brandData.masterCategory = req.body.masterCategory;
        }

        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        const brand = await Brand.create({
            ...brandData,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id
        });
        res.status(201).json({ success: true, brand });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getBrands = async (req, res) => {
    try {
        const query = { isDeleted: false };
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }

        const brands = await Brand.find(query)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 });
        res.json({ success: true, brands });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getBrandById = async (req, res) => {
    try {
        const brand = await Brand.findById(req.params.id)
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' });
        if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });
        res.json({ success: true, brand });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateBrand = async (req, res) => {
    try {
        const brandData = { ...req.body };
        if (req.file) {
            brandData.logo = req.file.path;
        } else if (req.body.removeImage === 'true') {
            brandData.logo = null;
        }
        delete brandData.removeImage;

        if (req.body.masterCategory) {
            brandData.masterCategory = req.body.masterCategory;
        }

        const brand = await Brand.findByIdAndUpdate(req.params.id,
            { ...brandData, updatedBy: req.user?._id },
            { new: true }
        );
        if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });
        res.json({ success: true, brand });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteBrand = async (req, res) => {
    try {
        const brand = await Brand.findById(req.params.id);
        if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });

        brand.isDeleted = true;
        await brand.save();

        res.json({ success: true, message: 'Brand deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateBrandStatus = async (req, res) => {
    try {
        const brand = await Brand.findByIdAndUpdate(req.params.id,
            { status: req.body.status, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, brand });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getPublicBrandLogo = async (req, res) => {
    try {
        const brand = await Brand.findById(req.params.id);
        if (!brand || !brand.logo) {
            return res.redirect(`https://ui-avatars.com/api/?name=Brand&background=4f46e5&color=fff&size=256&bold=true`);
        }

        const imagePath = path.resolve(process.cwd(), brand.logo);
        if (fs.existsSync(imagePath)) {
            res.sendFile(imagePath, (err) => {
                if (err && !res.headersSent) {
                    return res.redirect(`https://ui-avatars.com/api/?name=${encodeURIComponent(brand.name || 'Brand')}&background=4f46e5&color=fff&size=256&bold=true`);
                }
            });
        } else {
            return res.redirect(`https://ui-avatars.com/api/?name=${encodeURIComponent(brand.name || 'Brand')}&background=4f46e5&color=fff&size=256&bold=true`);
        }
    } catch (error) {
        res.redirect(`https://ui-avatars.com/api/?name=Brand&background=4f46e5&color=fff&size=256&bold=true`);
    }
};
