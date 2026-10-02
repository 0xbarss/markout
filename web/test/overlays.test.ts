import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMarkers } from "../src/overlays/markers.ts";
import { buildSignalMarkers } from "../src/overlays/signals.ts";
import { barIndexAt, locate } from "../src/overlays/snap.ts";
import { buildTrail, spanOf } from "../src/overlays/sl_tp_trail.ts";
import { baseInterval, resample } from "../src/resample.ts";
import type { Bar, Signal, Trade } from "../src/types";

const T0 = 1_700_000_100, STEP = 900;
const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
  time: T0 + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1,
}));
const at = (i: number, off = 0) => T0 + i * STEP + off;

function trade(over: Partial<Trade>): Trade {
  return {
    id: 1, symbol: "X", direction: "buy", size: 1, entry_time: at(2), entry_price: 100,
    exit_time: at(8, 300), exit_price: 104, exit_reason: "take_profit", initial_sl: 98,
    take_profit: 105, sl_history: [], pnl: 4, r_multiple: 2, fee: 0, mae_pct: null, mfe_pct: null, ...over,
  };
}

test("barIndexAt / locate", () => {
  assert.equal(barIndexAt(bars, T0 - 1), -1);
  assert.equal(barIndexAt(bars, T0), 0);
  assert.equal(barIndexAt(bars, at(5, 899)), 5);
  assert.equal(locate(bars, at(19, 899)), 19);
  assert.equal(locate(bars, at(20)), -1); // beyond the last bar's interval
});

test("markers: sorted, snapped to bar times, labelled", () => {
  const m = buildMarkers([trade({ id: 2, entry_time: at(10, 5), exit_time: at(12) }), trade({})], bars);
  assert.deepEqual(m.map((x) => x.time), [at(2), at(8), at(10), at(12)]);
  assert.equal(m[0].shape, "arrowUp");
  assert.equal(m[0].position, "belowBar");
  assert.match(m[0].text ?? "", /^Buy @ 100\.000$/);
  assert.match(m[1].text ?? "", /^TP \+2\.00R$/);
});

test("markers: short trade points down; out-of-range trades are dropped", () => {
  const short = buildMarkers([trade({ direction: "sell", pnl: -1, r_multiple: -1, exit_reason: "initial_stop" })], bars);
  assert.equal(short[0].shape, "arrowDown");
  assert.equal(short[1].color, "#f6465d");
  assert.deepEqual(buildMarkers([trade({ entry_time: at(0, -10_000), exit_time: at(0, -5_000) })], bars), []);
});

test("trail: stop path is a step series that holds the last level until exit", () => {
  const t = trade({ sl_history: [{ time: at(4), price: 99 }, { time: at(6, 100), price: 100.5 }] });
  const { sl, tp } = buildTrail([t], bars);
  assert.equal(sl.length, 1);
  assert.deepEqual(sl[0].map((p) => [p.time, p.value]), [
    [at(2), 98], [at(4), 99], [at(6), 100.5], [at(8), 100.5],
  ]);
  assert.deepEqual(tp[0].map((p) => [p.time, p.value]), [[at(2), 105], [at(8), 105]]);
});

test("trail: stop moves on the same bar keep the last value; moves before entry clamp to entry", () => {
  const t = trade({ sl_history: [{ time: at(0), price: 97 }, { time: at(4), price: 99 }, { time: at(4, 60), price: 99.5 }] });
  const pts = buildTrail([t], bars).sl[0];
  assert.deepEqual(pts.map((p) => p.value), [97, 99.5, 99.5]);
  assert.deepEqual(pts.map((p) => p.time), [at(2), at(4), at(8)]);
});

test("trail: sequential trades share a lane with a gap; overlapping trades get new lanes", () => {
  const a = trade({ id: 1, entry_time: at(1), exit_time: at(5) });
  const b = trade({ id: 2, entry_time: at(8), exit_time: at(12) });
  const c = trade({ id: 3, entry_time: at(3), exit_time: at(9) });
  const lanes = buildTrail([a, b, c], bars).sl;
  assert.equal(lanes.length, 2);
  const gapIdx = lanes[0].findIndex((p) => p.value === undefined);
  assert.ok(gapIdx > 0, "gap point separates segments");
  assert.equal(lanes[0][gapIdx].time, at(6));
  // times are strictly ascending within every lane (a chart requirement)
  for (const lane of lanes) for (let i = 1; i < lane.length; i++) assert.ok(lane[i].time > lane[i - 1].time);
});

test("trail: back-to-back trades (exit bar + 1 == next entry bar) do not share a lane", () => {
  const a = trade({ id: 1, entry_time: at(1), exit_time: at(5) });
  const b = trade({ id: 2, entry_time: at(6), exit_time: at(9) });
  assert.equal(buildTrail([a, b], bars).sl.length, 2);
});

test("spanOf: open trades run to the last bar; same-bar and out-of-range trades are skipped", () => {
  assert.deepEqual(spanOf(trade({ exit_time: null }), bars), [2, 19]);
  assert.equal(spanOf(trade({ entry_time: at(3), exit_time: at(3, 100) }), bars), null);
  assert.equal(spanOf(trade({ entry_time: at(40), exit_time: null }), bars), null);
  assert.equal(spanOf(trade({ entry_time: at(0, -9000), exit_time: at(0, -1) }), bars), null);
  assert.deepEqual(spanOf(trade({ entry_time: at(0, -9000), exit_time: at(3) }), bars), [0, 3]);
});

test("resample aggregates OHLCV into buckets", () => {
  const four: Bar[] = [
    { time: 0, open: 1, high: 3, low: 1, close: 2, volume: 1 },
    { time: 900, open: 2, high: 5, low: 2, close: 4, volume: 2 },
    { time: 1800, open: 4, high: 4, low: 0.5, close: 1, volume: 3 },
    { time: 3600, open: 1, high: 2, low: 1, close: 2, volume: 4 },
  ];
  assert.equal(baseInterval(four), 900);
  assert.deepEqual(resample(four, 3600), [
    { time: 0, open: 1, high: 5, low: 0.5, close: 1, volume: 6 },
    { time: 3600, open: 1, high: 2, low: 1, close: 2, volume: 4 },
  ]);
});

test("sample data: every trade produces a drawable, ordered trail", () => {
  const csv = readFileSync(new URL("../../examples/bars.csv", import.meta.url), "utf8").trim().split("\n").slice(1);
  const sample: Bar[] = csv.map((l) => {
    const [time, open, high, low, close, volume] = l.split(",").map(Number);
    return { time, open, high, low, close, volume };
  });
  const trades: Trade[] = readFileSync(new URL("../../examples/trades.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const { sl, tp } = buildTrail(trades, sample);
  assert.ok(sl.length >= 1 && tp.length >= 1);
  for (const lane of [...sl, ...tp]) for (let i = 1; i < lane.length; i++) assert.ok(lane[i].time > lane[i - 1].time);
  assert.equal(buildMarkers(trades, sample).length, trades.length * 2);
});

test("strategy signals: visual markers for buy and sell, omit hold", () => {
  const sigs: Signal[] = [
    {
      id: "sig_1",
      time: at(2),
      direction: "buy",
      entry_price: 100.5,
      stop_loss: 98.0,
      take_profit: 105.0,
      strategy: "Cayenne",
    },
    {
      id: "sig_2",
      time: at(5),
      direction: "sell",
      entry_price: 103.0,
      stop_loss: 105.0,
      take_profit: 100.0,
      strategy: "Eclipse",
    },
    {
      id: "sig_3",
      time: at(7),
      direction: "hold",
      entry_price: 0,
      stop_loss: 0,
      take_profit: 0,
    },
  ];
  const markers = buildSignalMarkers(sigs, bars);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].position, "belowBar");
  assert.equal(markers[0].shape, "arrowUp");
  assert.ok((markers[0].text as string).includes("Cayenne Buy @ 100.50"));

  assert.equal(markers[1].position, "aboveBar");
  assert.equal(markers[1].shape, "arrowDown");
  assert.ok((markers[1].text as string).includes("Eclipse Sell @ 103.00"));
});
