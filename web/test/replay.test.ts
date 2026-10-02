import assert from "node:assert/strict";
import test from "node:test";
import { clipTradesForReplay } from "../src/replay/ghost.ts";
import { ReplayController, SUPPORTED_SPEEDS } from "../src/replay/controller.ts";
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
