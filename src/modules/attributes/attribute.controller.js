const Attribute = require('./attribute.model');

exports.createAttribute = async (req, res) => {
    try {
        const attribute = await Attribute.create({ ...req.body, createdBy: req.user?._id });
        res.status(201).json({ success: true, attribute });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getAttributes = async (req, res) => {
    try {
        const attributes = await Attribute.find();
        res.json({ success: true, attributes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateAttribute = async (req, res) => {
    try {
        const attribute = await Attribute.findByIdAndUpdate(req.params.id,
            { ...req.body, updatedBy: req.user?._id },
            { new: true }
        );
        res.json({ success: true, attribute });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteAttribute = async (req, res) => {
    try {
        await Attribute.findByIdAndUpdate(req.params.id, { isDeleted: true });
        res.json({ success: true, message: 'Attribute deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
