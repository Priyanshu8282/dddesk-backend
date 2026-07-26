const GlobalSetting = require('./setting.model');
const ApiError = require('../../utils/ApiError');

// Get all settings or a specific setting
exports.getSettings = async (req, res, next) => {
    try {
        const { key } = req.query;
        let query = {};
        if (key) {
            query.key = key;
        }

        const settings = await GlobalSetting.find(query);

        res.status(200).json({
            success: true,
            data: key && settings.length > 0 ? settings[0] : settings
        });
    } catch (error) {
        next(error);
    }
};

// Update or Create a setting
exports.updateSetting = async (req, res, next) => {
    try {
        const { key, value, description } = req.body;

        if (!key || value === undefined) {
            throw new ApiError(400, 'Key and value are required');
        }

        const setting = await GlobalSetting.findOneAndUpdate(
            { key },
            { value, description, key },
            { new: true, upsert: true, runValidators: true }
        );

        res.status(200).json({
            success: true,
            message: 'Setting updated successfully',
            data: setting
        });
    } catch (error) {
        next(error);
    }
};
