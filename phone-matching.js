const GSM_MASK_CHARS = "*xX\u2022\u2023\u2027\u2219\u2217\u25CF\u25E6\u00B7";
const GSM_MASK_CLASS = `[${GSM_MASK_CHARS}]`;
const GSM_MASKED_RE = new RegExp(`(?:(?:\\+|00)?90)?0?5\\d{2}${GSM_MASK_CLASS}{2,}\\d{4}`);
const GSM_MASKED_GLOBAL_RE = new RegExp(GSM_MASKED_RE.source, "g");
const PORTAL_FULL_NUMBER_GLOBAL_RE = /(?:(?:\+|00)?90[\s().\/-]*)?0?5(?:[\s().\/-]*\d){9}/g;

function asciiDigits(value) {
  return String(value ?? "")
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, digit => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/[\uFF10-\uFF19]/g, digit => String(digit.charCodeAt(0) - 0xFF10));
}

function numericCellText(value) {
  const text = asciiDigits(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(text)) return text;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number.toFixed(0) : text;
}

function nationalMobileDigits(value) {
  let digits = numericCellText(value).replace(/\D/g, "");
  if (/^00905\d{9}$/.test(digits)) digits = digits.slice(4);
  else if (/^905\d{9}$/.test(digits)) digits = digits.slice(2);
  if (/^5\d{9}$/.test(digits)) digits = `0${digits}`;
  return /^05\d{9}$/.test(digits) ? digits : "";
}

function maskedNumberParts(value) {
  const text = asciiDigits(value).trim().replace(/\s+/g, "");
  const match = text.match(GSM_MASKED_RE);
  if (!match) return null;
  const localMatch = match[0].match(new RegExp(`(0?5\\d{2})${GSM_MASK_CLASS}{2,}(\\d{4})$`));
  if (!localMatch) return null;
  const prefix = localMatch[1].startsWith("0") ? localMatch[1] : `0${localMatch[1]}`;
  return { prefix, suffix: localMatch[2] };
}

function normalizeGsm(value) {
  const masked = maskedNumberParts(value);
  if (masked) return `${masked.prefix}***${masked.suffix}`;
  const national = nationalMobileDigits(value);
  if (national) return `${national.slice(0, 4)}***${national.slice(-4)}`;
  return asciiDigits(value).trim();
}

function canonicalGsm(value) {
  const normalized = normalizeGsm(value);
  const masked = String(normalized || "").match(/05\d{2}\*{3}\d{4}/);
  return masked ? masked[0] : "";
}

function gsmEdgeKey(value) {
  const masked = maskedNumberParts(value);
  if (masked) return `${masked.prefix}:${masked.suffix}`;
  const national = nationalMobileDigits(value);
  return national ? `${national.slice(0, 4)}:${national.slice(-4)}` : "";
}

function gsmMatchKeys(value) {
  const keys = new Set();
  const canonical = canonicalGsm(value);
  const edge = gsmEdgeKey(value);
  if (canonical) keys.add(`canon:${canonical}`);
  if (edge) keys.add(`edge:${edge}`);
  return Array.from(keys);
}

function normalizePortalImportNumber(value) {
  const masked = maskedNumberParts(value);
  if (masked) return `${masked.prefix}***${masked.suffix}`;
  return nationalMobileDigits(value);
}

function portalNumbersFromCell(value) {
  const raw = numericCellText(value);
  const found = [];
  const add = candidate => {
    const normalized = normalizePortalImportNumber(candidate);
    if (normalized && !found.includes(normalized)) found.push(normalized);
  };
  for (const match of raw.matchAll(GSM_MASKED_GLOBAL_RE)) add(match[0]);
  for (const match of raw.matchAll(PORTAL_FULL_NUMBER_GLOBAL_RE)) add(match[0]);
  if (!found.length) add(raw);
  return found;
}

function portalNumberFromCell(value) {
  return portalNumbersFromCell(value)[0] || "";
}

module.exports = {
  canonicalGsm,
  gsmEdgeKey,
  gsmMatchKeys,
  nationalMobileDigits,
  normalizeGsm,
  normalizePortalImportNumber,
  portalNumberFromCell,
  portalNumbersFromCell
};
