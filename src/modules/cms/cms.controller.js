const cmsService = require('./cms.service');

// A generic catchAsync implementation since the project doesn't have one globally in utils
const catchAsync = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(err));
};

// Terms
const getTerms = catchAsync(async (req, res) => {
    const terms = await cmsService.getTerms();
    res.status(200).send(terms);
});

const updateTerms = catchAsync(async (req, res) => {
    const terms = await cmsService.updateTerms(req.body);
    res.status(200).send(terms);
});

// Privacy
const getPrivacy = catchAsync(async (req, res) => {
    const privacy = await cmsService.getPrivacy();
    res.status(200).send(privacy);
});

const updatePrivacy = catchAsync(async (req, res) => {
    const privacy = await cmsService.updatePrivacy(req.body);
    res.status(200).send(privacy);
});

// FAQs
const createFAQ = catchAsync(async (req, res) => {
    const faq = await cmsService.createFAQ(req.body);
    res.status(201).send(faq);
});

const getFAQs = catchAsync(async (req, res) => {
    const faqs = await cmsService.getFAQs();
    res.status(200).send(faqs);
});

const updateFAQ = catchAsync(async (req, res) => {
    const faq = await cmsService.updateFAQ(req.params.id, req.body);
    res.status(200).send(faq);
});

const deleteFAQ = catchAsync(async (req, res) => {
    await cmsService.deleteFAQ(req.params.id);
    res.status(204).send();
});

// Contact
const getContact = catchAsync(async (req, res) => {
    const contact = await cmsService.getContact();
    res.status(200).send(contact);
});

const updateContact = catchAsync(async (req, res) => {
    const contact = await cmsService.updateContact(req.body);
    res.status(200).send(contact);
});

// About
const getAbout = catchAsync(async (req, res) => {
    const about = await cmsService.getAbout();
    res.status(200).send(about);
});

const updateAbout = catchAsync(async (req, res) => {
    const about = await cmsService.updateAbout(req.body);
    res.status(200).send(about);
});

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
