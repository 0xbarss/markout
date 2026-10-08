import assert from "node:assert/strict";
import test from "node:test";
import { computeCountdown, formatCountdown } from "../src/ui/header.ts";

test("formatCountdown: formats seconds to MM:SS or H:MM:SS", () => {
  assert.equal(formatCountdown(0), "00:00");
  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(formatCountdown(45), "00:45");
  assert.equal(formatCountdown(90), "01:30");
  assert.equal(formatCountdown(3599), "59:59");
  assert.equal(formatCountdown(3600), "1:00:00");
  assert.equal(formatCountdown(3665), "1:01:05");
});

test("computeCountdown: returns dash for null bar time or invalid timeframe", () => {
  assert.equal(computeCountdown(null, 60, false, 1700000000), "—");
  assert.equal(computeCountdown(1700000000, 0, false, 1700000000), "—");
  assert.equal(computeCountdown(1700000000, -10, false, 1700000000), "—");
});

test("computeCountdown: historical data displays dash instead of 00:00", () => {
  const barTime = 1600000000; // Far in the past
  const now = 1700000000;
  const tf = 60; // 1-minute
  assert.equal(computeCountdown(barTime, tf, false, now), "—");
});

test("computeCountdown: live mode displays active remaining time even if behind", () => {
  const now = 1700000050;
  const barTime = 1700000000;
  const tf = 60;
  // Close time is 1700000060, remaining is 10s
  assert.equal(computeCountdown(barTime, tf, true, now), "00:10");

  // Past close time in live mode clamps to 00:00
  assert.equal(computeCountdown(barTime, tf, true, now + 20), "00:00");
});

test("computeCountdown: recent historical bar within 2 timeframes displays countdown", () => {
  const now = 1700000030;
  const barTime = 1700000000;
  const tf = 60;
  // barTime + tf = 1700000060, now - 2*tf = 1700000030 - 120 = 1699999910 <= 1700000060 (recent)
  assert.equal(computeCountdown(barTime, tf, false, now), "00:30");
});
