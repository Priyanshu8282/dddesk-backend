const { Terms, Privacy, FAQ, Contact, About } = require('./cms.model');
const httpStatus = require('http-status');
const ApiError = require('../../utils/ApiError');

// Terms
const getTerms = async () => {
    let terms = await Terms.findOne();
    if (!terms) terms = await Terms.create({ title: 'Terms & Conditions', content: '<p>Default Terms and Conditions</p>' });
    return terms;
};
const updateTerms = async (updateBody) => {
    let terms = await Terms.findOne();
    if (!terms) {
        terms = await Terms.create(updateBody);
    } else {
        Object.assign(terms, updateBody);
        await terms.save();
    }
    return terms;
};

// Privacy
const getPrivacy = async () => {
    let privacy = await Privacy.findOne();
    if (!privacy) privacy = await Privacy.create({ title: 'Privacy Policy', content: '<p>Default Privacy Policy</p>' });
    return privacy;
};
const updatePrivacy = async (updateBody) => {
    let privacy = await Privacy.findOne();
    if (!privacy) {
        privacy = await Privacy.create(updateBody);
    } else {
        Object.assign(privacy, updateBody);
        await privacy.save();
    }
    return privacy;
};

// FAQs
const createFAQ = async (faqBody) => {
    // get next order
    const maxOrderFaq = await FAQ.findOne().sort({ order: -1 });
    const order = maxOrderFaq ? maxOrderFaq.order + 1 : 1;
    return FAQ.create({ ...faqBody, order });
};
const getFAQs = async () => {
    return FAQ.find().sort({ order: 1 });
};
const getFAQById = async (id) => {
    const faq = await FAQ.findById(id);
    if (!faq) {
        throw new ApiError(httpStatus.NOT_FOUND, 'FAQ not found');
    }
    return faq;
}
const updateFAQ = async (id, updateBody) => {
    const faq = await getFAQById(id);
    Object.assign(faq, updateBody);
    await faq.save();
    return faq;
};
const deleteFAQ = async (id) => {
    const faq = await getFAQById(id);
    await faq.deleteOne();
    return faq;
};

// Contact
const getContact = async () => {
    let contact = await Contact.findOne();
    if (!contact) contact = await Contact.create({
        companyName: 'Company Name',
        address: '123 Street',
        email: 'info@example.com',
        phone: '1234567890'
    });
    return contact;
};
const updateContact = async (updateBody) => {
    let contact = await Contact.findOne();
    if (!contact) {
        contact = await Contact.create(updateBody);
    } else {
        Object.assign(contact, updateBody);
        await contact.save();
    }
    return contact;
};

// About
const getAbout = async () => {
    let about = await About.findOne();
    if (!about) about = await About.create({
        title: 'About Us',
        description: '<p>About Our Company</p>'
    });
    return about;
};
const updateAbout = async (updateBody) => {
    let about = await About.findOne();
    if (!about) {
        about = await About.create(updateBody);
    } else {
        Object.assign(about, updateBody);
        await about.save();
    }
    return about;
};

module.exports = {
    getTerms,
    updateTerms,
    getPrivacy,
    updatePrivacy,
    createFAQ,
    getFAQs,
    updateFAQ,
    deleteFAQ,
    getContact,
    updateContact,
    getAbout,
    updateAbout
};
