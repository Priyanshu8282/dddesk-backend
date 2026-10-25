const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const ApiError = require('./ApiError');

// Allow-list for legal documents written in the super admin's rich text editor.
// No style, class, id, script, iframe, form, image or event-handler attribute survives.
const MAX_BYTES = 300 * 1024;
const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'];

const OPTIONS = {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'span'],
    allowedAttributes: { a: ['href', 'target', 'rel'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedSchemes: SAFE_SCHEMES,
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // script, style, textarea, option and noscript content is dropped, not just the tag
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'template'],
    transformTags: {
        a: (tagName, attribs) => {
            const out = { rel: 'noopener noreferrer' };
            if (attribs.href) out.href = attribs.href;
            if (attribs.target === '_blank') out.target = '_blank';
            return { tagName: 'a', attribs: out };
        },
    },
    parser: { decodeEntities: true },
};

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] || m);

/** Sanitised HTML. Throws 400 when the input is not a string or is larger than 300 KB. */
const clean = (html) => {
    if (typeof html !== 'string') throw new ApiError(400, 'Content must be text');
    if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) throw new ApiError(400, 'This document is too large (maximum 300 KB)');
    const out = sanitizeHtml(html, OPTIONS).trim();
    // never keep a document whose only content is empty tags
    return out;
};

/** Plain text of already sanitised HTML, for search and meta descriptions. */
const toText = (html) => decode(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: OPTIONS.nonTextTags }))
    .replace(/\s+/g, ' ').trim();

const checksum = (title, html) => crypto.createHash('sha256').update(`${title}\n${html}`).digest('hex');

module.exports = { clean, toText, checksum, MAX_BYTES };
