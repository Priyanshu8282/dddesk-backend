const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { normalizeMobile } = require('../utils/mobile');
const { PRIVACY_POLICY_VERSION } = require('../utils/dpdp');
const Admin = require('../models/admin.model');
const Library = require('../models/library.model');
const PlatformPlan = require('../models/platformPlan.model');
const RegistrationDraft = require('../models/registrationDraft.model');
const platformSettings = require('./platformSettings.service');
const regVerify = require('./registrationVerification.service');
const validation = require('../validations/onboarding.validation');

// Self-registration wizard (draft + complete), public plans, product tour and the setup checklist.
// Contract: backend/doc/onboarding-contract.md

const coded = (status, errorCode, message, data) => Object.assign(new ApiError(status, message), { errorCode }, data ? { data } : {});

const TOUR_VERSION = 1;
const COMPLETING_STALE_MS = 2 * 60 * 1000;
const REQUIRED_FIELDS = ['name', 'ownerName', 'address', 'city', 'state', 'pincode', 'seatCapacity', 'workingHours.openingTime', 'workingHours.closingTime'];

// ------------------------------------------------------------------ public plans
const PLANS_TTL_MS = 60 * 1000;
let plansCache = { at: 0, value: null };

const serializePlan = (p) => ({
    id: String(p._id), name: p.name, slug: p.slug, description: p.description || '',
    monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice || 0,
    gstPercent: p.gstPercent, pricesIncludeGst: false,
    isPopular: !!p.isPopular, trialDays: p.trialDays,
    limits: { students: p.maxStudents, seats: p.maxSeats, staff: p.maxStaff, branches: p.maxBranches || 0 },
    features: Array.isArray(p.features) ? p.features.slice(0, 40) : [],
    sortOrder: p.sortOrder || 0,
});

const sortPlans = (a, b) => (a.sortOrder - b.sortOrder) || (a.monthlyPrice - b.monthlyPrice);

const listPublicPlans = async ({ fresh = false } = {}) => {
    await platformSettings.ensureFresh();
    const now = Date.now();
    if (!fresh && plansCache.value && now - plansCache.at < PLANS_TTL_MS) return plansCache.value;
    const rows = await PlatformPlan.find({ isActive: true, isDeleted: false }).lean();
    const value = rows.map(serializePlan).sort(sortPlans);
    plansCache = { at: now, value };
    return value;
};
const clearPlansCache = () => { plansCache = { at: 0, value: null }; };

// ------------------------------------------------------------------ helpers shared with the legacy register endpoint
/** "Auto-approve new libraries" (Platform Settings): activate and provision straight away. Never throws. */
const activateIfAutoApprove = async (created) => {
    let library = created;
    await platformSettings.ensureFresh();
    if (!platformSettings.autoApprove()) return library;
    try {
        library = (await Library.findOneAndUpdate({ _id: created._id, status: 'pending' }, { $set: { status: 'active', statusReason: null } }, { new: true })) || created;
        if (library.status === 'active') {
            await require('./libraryProvision.service').provisionLibrary(library);
            require('../utils/systemAudit')(library._id, 'library.auto_approved', 'Library', library._id, { by: 'platform settings' });
            library = (await Library.findById(created._id)) || library;
        }
    } catch (e) { console.error('[register] auto-approve failed, left pending:', e.message); }
    return library;
};

/** true when any non-deleted Admin account (any type) or any Library already uses this mobile */
const isMobileTaken = async (mobile) => {
    const [admin, lib] = await Promise.all([
        Admin.exists({ mobile, isDeleted: { $ne: true } }),
        Library.exists({ mobile, isDeleted: false }),
    ]);
    return !!(admin || lib);
};

// ------------------------------------------------------------------ draft
const publicDraft = (d, exists = true) => ({
    exists, step: d.step, mobile: d.mobile, planId: d.planId ? String(d.planId) : null, billingCycle: d.billingCycle,
    data: d.data && d.data.toObject ? d.data.toObject() : (d.data || {}),
    consent: { terms: !!d.consent?.terms, privacy: !!d.consent?.privacy, marketing: !!d.consent?.marketing },
    status: d.status, expiresAt: d.expiresAt,
});

const touch = () => new Date(Date.now() + RegistrationDraft.DRAFT_TTL_MS);

const getOrCreateDraft = async (token) => {
    const mobile = regVerify.mobileFromToken(token);
    if (await isMobileTaken(mobile)) throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
    const existing = await RegistrationDraft.findOne({ mobile });
    if (existing) {
        if (existing.status === 'completed') throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
        existing.expiresAt = touch();
        await existing.save();
        return publicDraft(existing);
    }
    try {
        const d = await RegistrationDraft.create({ mobile, expiresAt: touch() });
        return publicDraft(d, false);
    } catch (e) {
        if (e && e.code === 11000) return publicDraft(await RegistrationDraft.findOne({ mobile }));
        throw e;
    }
};

const flatten = (obj, prefix = '') => Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) Object.assign(acc, flatten(v, key));
    else acc[key] = v;
    return acc;
}, {});

const patchDraft = async (token, body, ip) => {
    const mobile = regVerify.mobileFromToken(token);
    if (await isMobileTaken(mobile)) throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
    const set = { expiresAt: touch() };
    if (body.step !== undefined) set.step = body.step;
    if (body.billingCycle) set.billingCycle = body.billingCycle;
    if (body.planId !== undefined) {
        if (body.planId === null) set.planId = null;
        else {
            const plan = await PlatformPlan.findOne({ _id: body.planId, isActive: true, isDeleted: false }).select('_id').lean();
            if (!plan) throw coded(409, 'PLAN_UNAVAILABLE', 'This plan is no longer available. Please choose another plan.');
            set.planId = plan._id;
        }
    }
    if (body.data) {
        // only allow-listed keys reach the database (the zod schema is strict as well)
        const allowed = new Set(RegistrationDraft.DATA_FIELDS);
        const clean = Object.fromEntries(Object.entries(body.data).filter(([k]) => allowed.has(k)));
        for (const [k, v] of Object.entries(flatten(clean))) set[`data.${k}`] = v;
    }
    if (body.consent) {
        for (const k of ['terms', 'privacy', 'marketing']) if (typeof body.consent[k] === 'boolean') set[`consent.${k}`] = body.consent[k];
        set['consent.version'] = PRIVACY_POLICY_VERSION;
        set['consent.at'] = new Date();
        set['consent.ip'] = ip || null;
    }
    let d;
    try {
        // upsert: a verified mobile may PATCH before GET created the draft; a draft that is completing/completed collides on the unique mobile
        d = await RegistrationDraft.findOneAndUpdate({ mobile, status: 'draft' }, { $set: set }, { new: true, upsert: true });
    } catch (e) {
        if (!(e && e.code === 11000)) throw e;
        const cur = await RegistrationDraft.findOne({ mobile }).select('status').lean();
        if (cur && cur.status === 'completing') throw coded(409, 'DRAFT_IN_PROGRESS', 'Your registration is being created. Please wait a moment.');
        throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
    }
    return publicDraft(d);
};

const missingFields = (data) => {
    const parsed = validation.completeData.safeParse(data);
    if (parsed.success) return [];
    const out = new Set();
    for (const i of parsed.error.issues) out.add(i.path.join('.') || 'data');
    return [...out];
};

const releaseClaim = (id) => RegistrationDraft.updateOne({ _id: id, status: 'completing' }, { $set: { status: 'draft', completingAt: null } }).catch(() => {});

// ------------------------------------------------------------------ complete
/**
 * Creates the Library + owner Admin from the verified draft. `issueSession(admin)` is called only when the library
 * is active (returns { token, userData, sessionId }). Idempotent per completeKey.
 */
const completeRegistration = async ({ token, body, ip, issueSession }) => {
    await platformSettings.ensureFresh();
    if (!platformSettings.registrationOpen()) throw coded(403, 'REGISTRATION_CLOSED', 'New library registrations are paused right now. Please try again later.');
    const mobile = regVerify.mobileFromToken(token);
    if (!body.consent || body.consent.terms !== true || body.consent.privacy !== true) {
        throw coded(400, 'CONSENT_REQUIRED', 'Please accept the Terms and the Privacy Policy to continue.');
    }

    const draft = await RegistrationDraft.findOne({ mobile });
    if (!draft) throw coded(422, 'DRAFT_INCOMPLETE', 'Please fill in your library details first.', { missing: REQUIRED_FIELDS.concat('planId') });

    // Idempotent replay: same key after success returns the same answer
    if (draft.status === 'completed') {
        if (draft.completeKey === body.completeKey && draft.result) return replay(draft, issueSession);
        throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
    }

    // Race guard: exactly one request may move draft -> completing
    const claimed = await RegistrationDraft.findOneAndUpdate(
        { _id: draft._id, $or: [{ status: 'draft' }, { status: 'completing', completingAt: { $lt: new Date(Date.now() - COMPLETING_STALE_MS) } }] },
        { $set: { status: 'completing', completeKey: body.completeKey, completingAt: new Date() } },
        { new: true },
    );
    if (!claimed) throw coded(409, 'DRAFT_IN_PROGRESS', 'Your registration is being created. Please retry in a moment.');

    try {
        const data = claimed.data.toObject ? claimed.data.toObject() : claimed.data;
        const missing = missingFields(data);
        if (!claimed.planId) missing.push('planId');
        if (missing.length) throw coded(422, 'DRAFT_INCOMPLETE', 'Some details are still missing.', { missing });

        if (await isMobileTaken(mobile)) throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');

        const plan = await PlatformPlan.findOne({ _id: claimed.planId, isActive: true, isDeleted: false });
        if (!plan) throw coded(409, 'PLAN_UNAVAILABLE', 'The selected plan is no longer available. Please choose another plan.');

        const consent = { terms: true, privacy: true, marketing: !!body.consent.marketing, version: PRIVACY_POLICY_VERSION, at: new Date(), ip: ip || null };
        let created;
        try {
            created = await require('./admin.service').createLibraryWithAdmin({
                ...data, mobile, email: data.email || undefined,
                password: body.otpOnly ? undefined : body.password,
                subscriptionPlan: plan, billingCycle: claimed.billingCycle, registrationConsent: consent,
            }, null, null);
        } catch (e) {
            if (e && (e.code === 11000 || (e.status === 409 && /email/i.test(e.message || '')))) throw coded(409, 'EMAIL_TAKEN', 'An account with this e-mail already exists. Use another e-mail or leave it blank.');
            if (e && e.status === 409) throw coded(409, 'ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
            throw e;
        }

        const library = await activateIfAutoApprove(created.library);
        const admin = created.admin;

        // optional quick setup (wizard step 5): one default membership plan with its standard fee and shift. Never blocks sign-up.
        let defaultPlanCreated = false;
        const qs = data.quickSetup || {};
        if (qs.planName && Number(qs.planFee) > 0) {
            try {
                await require('../models/plan.model').create({
                    libraryId: library._id, name: qs.planName, durationType: qs.planDuration || 'monthly', price: Number(qs.planFee),
                    ...(qs.shiftName ? { shiftName: qs.shiftName } : {}), ...(qs.shiftStart ? { shiftStart: qs.shiftStart } : {}), ...(qs.shiftEnd ? { shiftEnd: qs.shiftEnd } : {}),
                    createdBy: admin._id,
                });
                defaultPlanCreated = true;
            } catch (e) { console.error('[register] default plan not created:', e.message); }
        }
        const result = {
            status: library.status,
            library: { id: String(library._id), name: library.name, status: library.status, libraryCode: library.libraryCode },
            plan: { id: String(plan._id), name: plan.name, billingCycle: claimed.billingCycle, trialEndsAt: library.trialEndsAt || null },
            admin: { id: String(admin._id), name: admin.name, mobile },
            tour: { pending: true },
            setup: { defaultPlanCreated },
        };

        await RegistrationDraft.updateOne(
            { _id: claimed._id },
            { $set: { status: 'completed', result, data: {}, consent: { terms: true, privacy: true, marketing: !!body.consent.marketing, version: consent.version, at: consent.at, ip: null }, completingAt: null, expiresAt: new Date(Date.now() + RegistrationDraft.DONE_TTL_MS) } },
        );
        try { require('../utils/systemAudit')(library._id, 'library.self_registered', 'Library', library._id, { status: library.status, plan: plan.name, otpOnly: !!body.otpOnly }); } catch (_) { /* audit must not break sign-up */ }

        return withSession(result, admin._id, library.status === 'active', issueSession);
    } catch (e) {
        await releaseClaim(claimed._id);
        throw e;
    }
};

const withSession = async (result, adminId, active, issueSession) => {
    if (!active || !issueSession) return result;
    const s = await issueSession(adminId);
    return s ? { ...result, token: s.token, expiresIn: require('../config/config').jwt.accessTtlSeconds, user: s.userData } : result;
};

const replay = (draft, issueSession) => withSession(draft.result, draft.result.admin.id, draft.result.status === 'active', issueSession);

// ------------------------------------------------------------------ tour
const tourOf = (admin) => {
    const t = (admin && admin.tour) || {};
    const done = !!t.completed || !!t.skippedAt;
    return {
        completed: !!t.completed, skippedAt: t.skippedAt || null, lastStep: t.lastStep || 0, version: t.version || 0,
        pending: !(done && (t.version || 0) >= TOUR_VERSION),
        ...(admin && admin.userType === 'superadmin' ? { tourScope: 'superadmin' } : {}),
    };
};

const updateTour = async (adminId, { lastStep, completed, skipped, restart }) => {
    const set = {};
    const unset = {};
    if (restart) { set['tour.completed'] = false; set['tour.skippedAt'] = null; set['tour.lastStep'] = 0; }
    else {
        if (lastStep !== undefined) set['tour.lastStep'] = lastStep;
        if (completed) { set['tour.completed'] = true; set['tour.version'] = TOUR_VERSION; }
        if (skipped) { set['tour.skippedAt'] = new Date(); set['tour.version'] = TOUR_VERSION; }
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) throw new ApiError(400, 'Nothing to update');
    const admin = await Admin.findOneAndUpdate({ _id: adminId, isDeleted: { $ne: true } }, { $set: set }, { new: true }).select('tour userType');
    if (!admin) throw new ApiError(404, 'User not found');
    return tourOf(admin);
};

// ------------------------------------------------------------------ checklist
const PROFILE_REQUIRED = ['name', 'ownerName', 'address', 'city', 'state', 'pincode', 'seatCapacity'];
const PROFILE_OPTIONAL = ['logo', 'gstNumber', 'description'];

const profileState = (lib) => {
    const requiredMissing = PROFILE_REQUIRED.filter((k) => !lib[k]);
    const wh = lib.workingHours || {};
    if (!wh.openingTime || !wh.closingTime) requiredMissing.push('workingHours');
    const optionalMissing = PROFILE_OPTIONAL.filter((k) => !lib[k]);
    return { done: requiredMissing.length === 0, missing: [...requiredMissing, ...optionalMissing] };
};

const buildChecklist = ({ counts, profile, trialEndsAt, now = Date.now() }) => {
    const items = [
        { key: 'profile', label: 'Complete library profile', done: profile.done, href: '/dashboard/settings' },
        { key: 'plan', label: 'Create a membership plan', done: counts.plans > 0, href: '/dashboard/plans/add' },
        { key: 'seats', label: 'Add seats', done: counts.seats > 0, href: '/dashboard/seats' },
        { key: 'student', label: 'Add your first student', done: counts.students > 0, href: '/dashboard/students/add' },
        { key: 'payment', label: 'Collect your first payment', done: counts.payments > 0, href: '/dashboard/payments' },
    ];
    const doneCount = items.filter((i) => i.done).length;
    const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now) / 86400000)) : null;
    return {
        percent: Math.round((doneCount / items.length) * 100), complete: doneCount === items.length, items, counts,
        profile: { missing: profile.missing },
        trial: { endsAt: trialEndsAt || null, daysLeft },
    };
};

const checklist = async (req) => {
    if (req.userType === 'superadmin' || !req.libraryId) throw new ApiError(403, 'The setup checklist is only for library accounts');
    const { branchFilter } = require('../utils/branchScope');
    const libId = new mongoose.Types.ObjectId(String(req.libraryId));
    const bf = branchFilter(req);
    const Plan = require('../models/plan.model');
    const Seat = require('../models/seat.model');
    const Student = require('../models/student.model');
    const PaymentTransaction = require('../models/paymentTransaction.model');
    const [lib, plans, seats, students, payments] = await Promise.all([
        Library.findById(libId).select('name ownerName address city state pincode seatCapacity workingHours logo gstNumber description trialEndsAt').lean(),
        Plan.countDocuments({ libraryId: libId, isDeleted: false }),
        Seat.countDocuments({ libraryId: libId, ...bf }),
        Student.countDocuments({ libraryId: libId, ...bf }),
        PaymentTransaction.countDocuments({ libraryId: libId, status: 'success' }),
    ]);
    if (!lib) throw new ApiError(404, 'Library not found');
    return buildChecklist({ counts: { plans, seats, students, payments }, profile: profileState(lib), trialEndsAt: lib.trialEndsAt });
};

/** Public website contact form: stored, and the platform owners are alerted (in-app + e-mail). */
const submitContact = async (body, ip) => {
    const ContactMessage = require('../models/contactMessage.model');
    const doc = await ContactMessage.create({ name: body.name, mobile: body.mobile || '', email: body.email || '', subject: body.subject || '', message: body.message, ip: ip || null });
    require('./platformAlerts.service').notify('contactMessage', {
        message: `${body.name} (${body.mobile || body.email}) wrote: ${String(body.message).slice(0, 300)}`,
        dedupeKey: `contact:${doc._id}`,
        data: { contactMessageId: String(doc._id) },
    });
    return { id: String(doc._id) };
};

module.exports = {
    submitContact,
    TOUR_VERSION, REQUIRED_FIELDS,
    serializePlan, sortPlans, listPublicPlans, clearPlansCache,
    activateIfAutoApprove, isMobileTaken,
    getOrCreateDraft, patchDraft, completeRegistration, missingFields, publicDraft,
    tourOf, updateTour, buildChecklist, profileState, checklist,
    normalizeMobile,
};
