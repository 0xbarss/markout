import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveState } from "../src/live.ts";
import { baseInterval, isResamplable, parseTimeframe, TIMEFRAMES } from "../src/resample.ts";
import type { Bar } from "../src/types.ts";

function makeBar(time: number, price = 100): Bar {
  return {
    time,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 10,
  };
}

describe("baseInterval & parseTimeframe", () => {
  it("baseInterval returns 0 for fewer than 2 bars", () => {
    assert.equal(baseInterval([]), 0);
    assert.equal(baseInterval([makeBar(1000)]), 0);
  });

  it("baseInterval calculates median spacing", () => {
    const bars = [makeBar(1000), makeBar(1060), makeBar(1120), makeBar(1180)];
    assert.equal(baseInterval(bars), 60);
  });

  it("baseInterval handles weekend/market gaps where median wins", () => {
    // 5 bars with 60s spacing, 1 large gap (172800s weekend), 5 more bars with 60s spacing
    const bars: Bar[] = [
      makeBar(1000),
      makeBar(1060),
      makeBar(1120),
      makeBar(1180),
      makeBar(1240),
      makeBar(1240 + 172800), // weekend gap
      makeBar(1240 + 172800 + 60),
      makeBar(1240 + 172800 + 120),
      makeBar(1240 + 172800 + 180),
      makeBar(1240 + 172800 + 240),
    ];
    assert.equal(baseInterval(bars), 60);
  });

  it("parseTimeframe parses numeric, exact labels, and suffixes", () => {
    assert.equal(parseTimeframe("15m"), 900);
    assert.equal(parseTimeframe("1h"), 3600);
    assert.equal(parseTimeframe("1D"), 86400);
    assert.equal(parseTimeframe("1W"), 604800);
    assert.equal(parseTimeframe("1M"), 2592000);
    assert.equal(parseTimeframe("60"), 60);
    assert.equal(parseTimeframe(900), 900);
    assert.equal(parseTimeframe("invalid"), null);
    assert.equal(parseTimeframe(""), null);
  });
});

describe("LiveState", () => {
  it("determines base interval after receiving second bar 900s later", () => {
    const state = new LiveState();
    const bars: Bar[] = [];

    assert.equal(state.getBase(), 0);
    assert.equal(state.getActive(), 0);

    // Feed first bar
    const res1 = state.onBar(bars, makeBar(1000));
    assert.equal(bars.length, 1);
    assert.equal(state.getBase(), 0);
    assert.equal(res1.needsReapply, false);

    // Feed second bar 900s later
    const res2 = state.onBar(bars, makeBar(1900));
    assert.equal(bars.length, 2);
    assert.equal(state.getBase(), 900);
    assert.equal(state.getActive(), 900);
    assert.equal(res2.needsReapply, true);

    // Verify which timeframes are resamplable from base 900 (15m)
    const enabledTimeframes = TIMEFRAMES.filter((tf) => isResamplable(state.getBase(), tf.sec)).map(
      (tf) => tf.label,
    );
    assert.ok(enabledTimeframes.includes("15m"));
    assert.ok(enabledTimeframes.includes("30m"));
    assert.ok(enabledTimeframes.includes("1h"));
    assert.ok(enabledTimeframes.includes("2h"));
    assert.ok(enabledTimeframes.includes("4h"));
    assert.ok(enabledTimeframes.includes("1D"));
    assert.ok(!enabledTimeframes.includes("1m"));
    assert.ok(!enabledTimeframes.includes("5m"));
    assert.ok(!enabledTimeframes.includes("10m"));
  });

  it("respects operator-configured initial base interval", () => {
    const state = new LiveState({ initialBase: 900 });
    const bars: Bar[] = [];

    assert.equal(state.getBase(), 900);
    assert.equal(state.getActive(), 900);

    const res = state.onBar(bars, makeBar(1000));
    assert.equal(bars.length, 1);
    assert.equal(res.needsReapply, true);
  });

  it("updates existing bar timestamp or appends out-of-order bars", () => {
    const state = new LiveState({ initialBase: 60 });
    const bars: Bar[] = [makeBar(1000, 100), makeBar(1060, 105)];

    // Intra-bar tick update on last bar
    const updated = state.onBar(bars, makeBar(1060, 107));
    assert.equal(bars.length, 2);
    assert.equal(bars[1].close, 107);
    assert.equal(updated.updatedBar.close, 107);
    assert.equal(updated.needsReapply, false);

    // Append new bar
    const nextBar = state.onBar(bars, makeBar(1120, 110));
    assert.equal(bars.length, 3);
    assert.equal(nextBar.updatedBar.time, 1120);
    assert.equal(nextBar.needsReapply, false);
  });

  it("aggregates higher timeframe bars when active > base", () => {
    const state = new LiveState({ initialBase: 60 });
    state.setActive(300); // 5m
    const bars: Bar[] = [];

    // t=0 (0m)
    state.onBar(bars, { time: 0, open: 10, high: 15, low: 8, close: 12, volume: 100 });
    // t=60 (1m)
    state.onBar(bars, { time: 60, open: 12, high: 20, low: 11, close: 18, volume: 150 });
    // t=120 (2m)
    const r3 = state.onBar(bars, { time: 120, open: 18, high: 19, low: 7, close: 14, volume: 50 });

    assert.equal(r3.updatedBar.time, 0); // bucket time is 0
    assert.equal(r3.updatedBar.open, 10);
    assert.equal(r3.updatedBar.high, 20);
    assert.equal(r3.updatedBar.low, 7);
    assert.equal(r3.updatedBar.close, 14);
    assert.equal(r3.updatedBar.volume, 300);
  });
});
