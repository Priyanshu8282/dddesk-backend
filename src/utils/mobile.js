// Normalize Indian mobile numbers typed as "+91 98765 43210", "09876543210", "98765-43210" -> "9876543210".
// Anything that is not recognisably a 10-digit Indian number is returned digits-only (leading + kept) unchanged.
const normalizeMobile = (value) => {
  if (value === undefined || value === null) return value;
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return raw.startsWith('+') ? `+${digits}` : digits;
};

module.exports = { normalizeMobile };
