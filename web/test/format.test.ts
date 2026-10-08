import assert from "node:assert/strict";
import test from "node:test";
import { fmt, fmtDuration, fmtPrice, fmtSigned, precisionFor, signClass } from "../src/format.ts";

test("fmtSigned: formats percentage values with consistent sign and decimals", () => {
  assert.equal(`${fmtSigned(0.8, 2)}%`, "+0.80%");
  assert.equal(`${fmtSigned(12.34, 2)}%`, "+12.34%");
  assert.equal(`${fmtSigned(1500, 2)}%`, "+1,500.00%");
  assert.equal(`${fmtSigned(-2.5, 2)}%`, "-2.50%");
  assert.equal(`${fmtSigned(0, 2)}%`, "0.00%");
});

test("fmtSigned: currency prefix and sign handling", () => {
  assert.equal(fmtSigned(250.5, 2, "$"), "+$250.50");
  assert.equal(fmtSigned(-50.25, 2, "$"), "-$50.25");
  assert.equal(fmtSigned(0, 2, "$"), "$0.00");
});

test("fmtPrice & precisionFor: formats magnitude-based prices correctly", () => {
  assert.equal(precisionFor(1500), 2);
  assert.equal(precisionFor(50.5), 3);
  assert.equal(precisionFor(1.23456), 5);

  assert.equal(fmtPrice(1500.1), "1,500.10");
  assert.equal(fmtPrice(42.5), "42.500");
  assert.equal(fmtPrice(1.0825), "1.08250");
});

test("signClass: returns up, down, or empty", () => {
  assert.equal(signClass(10), "up");
  assert.equal(signClass(-5), "down");
  assert.equal(signClass(0), "");
});

test("fmtDuration: human-readable duration strings", () => {
  assert.equal(fmtDuration(45), "0m");
  assert.equal(fmtDuration(120), "2m");
  assert.equal(fmtDuration(3600), "1h");
  assert.equal(fmtDuration(3660), "1h 1m");
  assert.equal(fmtDuration(86400), "1d");
  assert.equal(fmtDuration(90060), "1d 1h 1m");
});
