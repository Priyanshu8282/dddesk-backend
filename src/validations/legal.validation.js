const { z } = require('zod');

const type = z.string().trim().min(3).max(60);
const version = z.coerce.number().int().min(1).max(100000);
const typeParam = z.object({ type });
const versionParam = z.object({ type, version });

const createDraft = z.object({
    params: typeParam,
    body: z.object({
        from: z.enum(['published', 'blank', 'version']).default('published'),
        version: version.optional(),
    }).strict().refine((b) => b.from !== 'version' || b.version, { message: 'Choose which version to copy', path: ['version'] }),
});

const saveDraft = z.object({
    params: typeParam,
    body: z.object({
        title: z.string().trim().min(1, 'Enter a title').max(200).optional(),
        contentHtml: z.string().max(400 * 1024).optional(),
        revision: z.coerce.number().int().min(1),
    }).strict(),
});

const publish = z.object({
    params: typeParam,
    body: z.object({
        revision: z.coerce.number().int().min(1),
        summaryOfChanges: z.string().trim().min(3, 'Describe what changed').max(1000),
        effectiveFrom: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.date().optional()),
        password: z.string().min(1, 'Enter your password to confirm').max(200),
    }).strict(),
});

const versionsList = z.object({ params: typeParam });
const getVersion = z.object({ params: versionParam });
const restore = z.object({ params: versionParam });
const compare = z.object({ params: typeParam, query: z.object({ a: version, b: version }) });
const publicVersion = z.object({ params: versionParam });
const publicOne = z.object({ params: typeParam });

module.exports = { createDraft, saveDraft, publish, versionsList, getVersion, restore, compare, publicVersion, publicOne, typeParam };
