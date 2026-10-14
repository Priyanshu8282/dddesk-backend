// Allow-list body fields to stop mass assignment (libraryId, role, isDeleted, ...)
module.exports = (obj = {}, keys = []) =>
    keys.reduce((o, k) => (obj[k] !== undefined ? { ...o, [k]: obj[k] } : o), {});
