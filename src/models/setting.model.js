const mongoose = require('mongoose');

const globalSettingSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    description: {
        type: String
    },
    // false = internal (counters etc.); only superadmin can read it through the API
    isPublic: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('GlobalSetting', globalSettingSchema);
