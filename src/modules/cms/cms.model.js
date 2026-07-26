const mongoose = require('mongoose');

const termsSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: Boolean, default: true }
}, { timestamps: true });

const privacySchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: Boolean, default: true }
}, { timestamps: true });

const faqSchema = new mongoose.Schema({
    question: { type: String, required: true },
    answer: { type: String, required: true },
    order: { type: Number, default: 0 },
    status: { type: Boolean, default: true }
}, { timestamps: true });

const contactSchema = new mongoose.Schema({
    companyName: { type: String, required: true },
    address: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    googleMapUrl: { type: String, default: '' },
    supportHours: { type: String, default: '' }
}, { timestamps: true });

const aboutSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    mission: { type: String, default: '' },
    vision: { type: String, default: '' },
    companyOverview: { type: String, default: '' }
}, { timestamps: true });

module.exports = {
    Terms: mongoose.model('cms_terms', termsSchema),
    Privacy: mongoose.model('cms_privacy', privacySchema),
    FAQ: mongoose.model('cms_faqs', faqSchema),
    Contact: mongoose.model('cms_contact', contactSchema),
    About: mongoose.model('cms_about', aboutSchema),
};
