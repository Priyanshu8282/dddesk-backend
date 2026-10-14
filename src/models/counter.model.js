const mongoose = require('mongoose');

// Generic atomic counter (e.g. per-library student registration numbers)
const counterSchema = new mongoose.Schema({
    _id: { type: String },
    seq: { type: Number, default: 0 }
}, { versionKey: false });

counterSchema.statics.next = async function (key) {
    const doc = await this.findOneAndUpdate(
        { _id: key },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return doc.seq;
};

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);
