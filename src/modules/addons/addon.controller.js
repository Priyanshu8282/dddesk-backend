const Addon = require('./addon.model');

exports.createAddon = async (req, res) => {
    try {
        const addon = await Addon.create({ ...req.body, createdBy: req.user?._id });
        res.status(201).json({ success: true, addon });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getAddons = async (req, res) => {
    try {
        const addons = await Addon.find();
        res.json({ success: true, addons });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateAddon = async (req, res) => {
    try {
        const addon = await Addon.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, addon });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteAddon = async (req, res) => {
    try {
        await Addon.findByIdAndUpdate(req.params.id, { isDeleted: true });
        res.json({ success: true, message: 'Addon deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
