const assert = require("assert");
const {
  canonicalGsm,
  gsmMatchKeys,
  normalizeGsm,
  normalizePortalImportNumber,
  portalNumbersFromCell
} = require("./phone-matching");

const fullNumber = "05321234567";
const canonical = "0532***4567";

for (const value of [
  fullNumber,
  "5321234567",
  "+90 532 123 45 67",
  "0090 (532) 123-45-67",
  "5.321234567E+9",
  "０５３２１２３４５６７"
]) {
  assert.equal(normalizeGsm(value), canonical, `Tam numara bicimi okunamadi: ${value}`);
  assert.equal(normalizePortalImportNumber(value), fullNumber, `Portal numarasi korunamadi: ${value}`);
}

for (const value of ["0532***4567", "532xxx4567", "+90 532•••4567", "0090532●●●4567"]) {
  assert.equal(canonicalGsm(value), canonical, `Maskeli numara okunamadi: ${value}`);
}

assert.deepEqual(
  portalNumbersFromCell("Uye: +90 (532) 123-45-67 / yedek 0544 987 65 43"),
  ["05321234567", "05449876543"]
);
assert.deepEqual(portalNumbersFromCell("0532***4567, 0532***4567"), [canonical]);
assert.deepEqual(portalNumbersFromCell("telefon yok"), []);
assert.ok(gsmMatchKeys(fullNumber).some(key => gsmMatchKeys(canonical).includes(key)));

console.log("phone-matching: tum testler basarili");
