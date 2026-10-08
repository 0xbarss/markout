import assert from "node:assert/strict";
import test from "node:test";
import { clipTradesForReplay, panelModel } from "../src/replay/ghost.ts";
import { ReplayController } from "../src/replay/controller.ts";
import type { Bar, Trade } from "../src/types.ts";

const T0 = 1_700_000_000;
const STEP = 60;
const makeBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    time: T0 + i * STEP,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 10,
  }));

const makeTrade = (over: Partial<Trade> = {}): Trade => ({
  id: 1,
  symbol: "BTCUSDT",
  direction: "buy",
  size: 1,
  entry_time: T0 + 2 * STEP,
  entry_price: 100,
  exit_time: T0 + 6 * STEP,
  exit_price: 105,
  exit_reason: "take_profit",
  initial_sl: 95,
  take_profit: 105,
  sl_history: [
    { time: T0 + 3 * STEP, price: 97 },
    { time: T0 + 5 * STEP, price: 99 },
  ],
  pnl: 5,
  r_multiple: 1.0,
  fee: 0,
  mae_pct: null,
  mfe_pct: null,
  ...over,
});

test("ghost mode: omits future trades", () => {
  const bars = makeBars(2); // bars 0 and 1 (time T0, T0 + 60)
  const trade = makeTrade({ entry_time: T0 + 2 * STEP });
  const clipped = clipTradesForReplay([trade], bars);
  assert.equal(clipped.length, 0);
});

test("ghost mode: masks exit and filters stop points for open trades", () => {
  const bars = makeBars(5); // bars 0 to 4 (time up to T0 + 4 * STEP)
  const trade = makeTrade();
  const clipped = clipTradesForReplay([trade], bars);

  assert.equal(clipped.length, 1);
  const t = clipped[0];
  assert.equal(t.exit_time, null);
  assert.equal(t.exit_price, null);
  assert.equal(t.exit_reason, null);
  assert.equal(t.pnl, 0);
  assert.equal(t.r_multiple, 0);
  assert.equal(t.fee, 0);
  assert.equal(t.mae_pct, null);
  assert.equal(t.mfe_pct, null);
  // sl_history should only include point at T0 + 3*STEP, not T0 + 5*STEP
  assert.equal(t.sl_history.length, 1);
  assert.equal(t.sl_history[0].time, T0 + 3 * STEP);
  assert.equal(t.sl_history[0].price, 97);
});

test("ghost mode: preserves completed trades when cursor is at or after exit", () => {
  const bars = makeBars(10);
  const trade = makeTrade();
  const clipped = clipTradesForReplay([trade], bars);

  assert.equal(clipped.length, 1);
  const t = clipped[0];
  assert.equal(t.exit_time, trade.exit_time);
  assert.equal(t.exit_price, trade.exit_price);
  assert.equal(t.exit_reason, trade.exit_reason);
  assert.equal(t.sl_history.length, 2);
});

test("replay controller: step, seek, and boundaries", () => {
  const bars = makeBars(5);
  const trades = [makeTrade()];
  const controller = new ReplayController(bars, trades);

  // Initialized at end
  assert.equal(controller.getCursor(), 4);
  assert.equal(controller.isLive(), true);
  assert.equal(controller.getVisibleBars().length, 5);

  // Seek
  controller.seek(2);
  assert.equal(controller.getCursor(), 2);
  assert.equal(controller.isLive(), false);
  assert.equal(controller.getVisibleBars().length, 3);

  // Step backward
  controller.stepBackward();
  assert.equal(controller.getCursor(), 1);

  // Step forward
  controller.stepForward();
  assert.equal(controller.getCursor(), 2);

  // Jump to live
  controller.jumpToLive();
  assert.equal(controller.getCursor(), 4);
  assert.equal(controller.isLive(), true);

  controller.destroy();
});

test("replay controller: speed selection and cycling", () => {
  const controller = new ReplayController(makeBars(3), []);
  assert.equal(controller.getSpeed(), 1);

  controller.setSpeed(10);
  assert.equal(controller.getSpeed(), 10);

  // Invalid speed ignored
  controller.setSpeed(7 as any);
  assert.equal(controller.getSpeed(), 10);

  // Cycle speed
  const next = controller.cycleSpeed();
  assert.equal(next, 20);

  controller.destroy();
});

test("replay controller: play and pause state transitions", () => {
  const controller = new ReplayController(makeBars(4), []);
  assert.equal(controller.getIsPlaying(), false);

  controller.seek(1);
  controller.play();
  assert.equal(controller.getIsPlaying(), true);

  controller.pause();
  assert.equal(controller.getIsPlaying(), false);

  controller.togglePlay();
  assert.equal(controller.getIsPlaying(), true);

  controller.togglePlay();
  assert.equal(controller.getIsPlaying(), false);

  controller.destroy();
});

test("replay controller: live bar updates when synced to live", () => {
  const bars = makeBars(3);
  const controller = new ReplayController(bars, []);

  assert.equal(controller.isLive(), true);
  assert.equal(controller.getCursor(), 2);

  // Update existing current bar
  const updatedBar: Bar = { ...bars[2], close: 150 };
  controller.appendOrUpdateBar(updatedBar);
  assert.equal(controller.getTotal(), 3);
  assert.equal(controller.getCursor(), 2);
  assert.equal(controller.getVisibleBars()[2].close, 150);

  // Append new incoming bar while live: cursor advances
  const newBar: Bar = {
    time: T0 + 3 * STEP,
    open: 150,
    high: 155,
    low: 149,
    close: 152,
    volume: 12,
  };
  controller.appendOrUpdateBar(newBar);
  assert.equal(controller.getTotal(), 4);
  assert.equal(controller.getCursor(), 3);
  assert.equal(controller.isLive(), true);

  controller.destroy();
});

test("replay controller: live bar updates when scrubbed back preserve cursor", () => {
  const bars = makeBars(4);
  const controller = new ReplayController(bars, []);

  // Scrub back to index 1
  controller.seek(1);
  assert.equal(controller.isLive(), false);
  assert.equal(controller.getCursor(), 1);

  // New bar arrives
  const newBar: Bar = {
    time: T0 + 4 * STEP,
    open: 110,
    high: 115,
    low: 108,
    close: 112,
    volume: 15,
  };
  controller.appendOrUpdateBar(newBar);
  assert.equal(controller.getTotal(), 5);
  // Cursor stays at 1
  assert.equal(controller.getCursor(), 1);
  assert.equal(controller.isLive(), false);

  // Jump to live snaps to the new latest bar
  controller.jumpToLive();
  assert.equal(controller.getCursor(), 4);
  assert.equal(controller.isLive(), true);

  controller.destroy();
});

test("replay controller: trade updates and risk bracket movements", () => {
  const bars = makeBars(7);
  const trade = makeTrade();
  const controller = new ReplayController(bars, [trade]);

  // Update risk bracket (trailing stop moved)
  controller.updateRiskBracket(1, 98.5, 108, T0 + 4 * STEP);
  let visibleTrades = controller.getVisibleTrades();
  assert.equal(visibleTrades.length, 1);
  assert.equal(visibleTrades[0].take_profit, 108);
  const lastPoint = visibleTrades[0].sl_history[visibleTrades[0].sl_history.length - 1];
  assert.equal(lastPoint.price, 98.5);

  // Update existing trade
  const modifiedTrade: Trade = { ...trade, pnl: 20 };
  controller.updateTrade(modifiedTrade);
  visibleTrades = controller.getVisibleTrades();
  assert.equal(visibleTrades[0].pnl, 20);

  controller.destroy();
});

test("panelModel: computes hindsight-free model across replay positions", () => {
  const bars = makeBars(10);
  const trade1 = makeTrade({
    id: 1,
    entry_time: T0 + 2 * STEP,
    exit_time: T0 + 5 * STEP,
    pnl: 10,
  });
  const trade2 = makeTrade({
    id: 2,
    entry_time: T0 + 6 * STEP,
    exit_time: T0 + 8 * STEP,
    pnl: -4,
  });
  const trades = [trade1, trade2];

  // At cursor = 1: before trade1 entry
  const frameBeforeEntry = {
    cursor: 1,
    total: 10,
    visibleBars: bars.slice(0, 2),
    visibleTrades: clipTradesForReplay(trades, bars.slice(0, 2)),
    visibleSignals: [],
    isLive: false,
  };
  const model0 = panelModel(frameBeforeEntry);
  assert.equal(model0.visibleTrades.length, 0);
  assert.equal(model0.stats.closed_trades, 0);
  assert.equal(model0.stats.net_pnl, 0);

  // At cursor = 3: trade1 is open, trade2 not entered
  const frameTrade1Open = {
    cursor: 3,
    total: 10,
    visibleBars: bars.slice(0, 4),
    visibleTrades: clipTradesForReplay(trades, bars.slice(0, 4)),
    visibleSignals: [],
    isLive: false,
  };
  const model1 = panelModel(frameTrade1Open);
  assert.equal(model1.visibleTrades.length, 1);
  assert.equal(model1.visibleTrades[0].exit_time, null);
  assert.equal(model1.visibleTrades[0].pnl, 0);
  assert.equal(model1.stats.open_trades, 1);
  assert.equal(model1.stats.closed_trades, 0);
  assert.equal(model1.stats.net_pnl, 0);

  // At cursor = 5: trade1 closed at T0 + 5*STEP
  const frameTrade1Closed = {
    cursor: 5,
    total: 10,
    visibleBars: bars.slice(0, 6),
    visibleTrades: clipTradesForReplay(trades, bars.slice(0, 6)),
    visibleSignals: [],
    isLive: false,
  };
  const model2 = panelModel(frameTrade1Closed);
  assert.equal(model2.visibleTrades.length, 1);
  assert.equal(model2.visibleTrades[0].exit_time, trade1.exit_time);
  assert.equal(model2.stats.open_trades, 0);
  assert.equal(model2.stats.closed_trades, 1);
  assert.equal(model2.stats.net_pnl, 10);
});

test("replay controller: getVisibleBars caching and out-of-order append", () => {
  const bars = makeBars(5);
  const controller = new ReplayController(bars, []);

  // Check that repeated calls at the same cursor return the identical array reference (cached)
  const v1 = controller.getVisibleBars();
  const v2 = controller.getVisibleBars();
  assert.equal(v1, v2);
  assert.equal(v1.length, 5);

  // Moving cursor invalidates cache and returns appropriate slice
  controller.seek(2);
  const v3 = controller.getVisibleBars();
  assert.notEqual(v1, v3);
  assert.equal(v3.length, 3);

  // Calling again returns cached v3
  const v4 = controller.getVisibleBars();
  assert.equal(v3, v4);

  // Appending an out-of-order bar updates correctly and preserves ordering
  const earlierBar: Bar = {
    time: bars[0].time + 10,
    open: 100,
    high: 105,
    low: 95,
    close: 101,
    volume: 10,
  };
  controller.appendOrUpdateBar(earlierBar);
  assert.equal(controller.getTotal(), 6);
  assert.equal(controller.getVisibleBars()[1].time, earlierBar.time);

  controller.destroy();
});

test("replay controller: preserves cursor timestamp across timeframe switch", () => {
  const baseBars = makeBars(10);
  const controller = new ReplayController(baseBars, []);

  // Scrub back to index 4 (T0 + 4 * 60)
  controller.seek(4);
  assert.equal(controller.getCursor(), 4);
  const preservedTime = controller.getVisibleBars().at(-1)?.time ?? null;
  assert.equal(preservedTime, T0 + 4 * STEP);

  // Switch timeframe to 5m (300s)
  const fiveMinBars: Bar[] = [
    { time: T0, open: 100, high: 110, low: 90, close: 105, volume: 50 },
    { time: T0 + 300, open: 105, high: 115, low: 95, close: 110, volume: 50 },
  ];

  controller.setData(fiveMinBars, [], [], preservedTime);
  // Cursor should be preserved at index 0 (T0 <= preservedTime) instead of jumping to the end (index 1)
  assert.equal(controller.getCursor(), 0);
  assert.equal(controller.getVisibleBars().at(-1)?.time, T0);

  controller.destroy();
});

