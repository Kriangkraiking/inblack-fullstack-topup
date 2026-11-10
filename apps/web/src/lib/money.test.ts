import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSatang, parseBahtToSatang } from "./money.ts";

test("formatSatang uses integer baht and two satang digits", () => {
  assert.equal(formatSatang(0), "0.00");
  assert.equal(formatSatang(5), "0.05");
  assert.equal(formatSatang(66980), "669.80");
  assert.equal(formatSatang(154000), "1,540.00");
  assert.equal(formatSatang(-2000), "-20.00");
  assert.throws(() => formatSatang(1.5));
});

test("parseBahtToSatang reads the string, never a float", () => {
  assert.equal(parseBahtToSatang("120"), 12000);
  assert.equal(parseBahtToSatang("120.5"), 12050);
  assert.equal(parseBahtToSatang("0.1"), 10);
  assert.equal(parseBahtToSatang("0.29"), 29);
  assert.equal(parseBahtToSatang("1,540.00"), 154000);
  assert.equal(parseBahtToSatang(" 669.80 "), 66980);
  assert.equal(parseBahtToSatang("1.234"), null);
  assert.equal(parseBahtToSatang("-1"), null);
  assert.equal(parseBahtToSatang("1e3"), null);
  assert.equal(parseBahtToSatang(""), null);
  assert.equal(parseBahtToSatang("abc"), null);
});
