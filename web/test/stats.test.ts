import assert from "node:assert/strict";
import test from "node:test";
import { computeStats } from "../src/stats.ts";
import type { Trade } from "../src/types.ts";

const makeTrade = (over: Partial<Trade> = {}): Trade => ({
  id: 1,
  symbol: "BTCUSDT",
  direction: "buy",
  size: 1,
  entry_time: 1000,
  entry_price: 100,
  exit_time: 2000,
  exit_price: 105,
  exit_reason: "take_profit",
  initial_sl: 95,
  take_profit: 105,
  sl_history: [],
  pnl: 5,
  r_multiple: 1.0,
  fee: 1,
  mae_pct: null,
  mfe_pct: null,
  ...over,
});

test("computeStats: empty trades list returns zeros", () => {
  const s = computeStats([]);
  assert.equal(s.total_trades, 0);
  assert.equal(s.open_trades, 0);
  assert.equal(s.closed_trades, 0);
  assert.equal(s.net_pnl, 0);
  assert.equal(s.win_rate, 0);
  assert.equal(s.avg_r, 0);
  assert.equal(s.max_drawdown, 0);
});

test("computeStats: correctly calculates pnl, win rate, and drawdown", () => {
  const trades: Trade[] = [
    makeTrade({ id: 1, exit_time: 10, pnl: 100, r_multiple: 2, fee: 2 }),
    makeTrade({ id: 2, exit_time: 20, pnl: -50, r_multiple: -1, fee: 2 }),
    makeTrade({ id: 3, exit_time: 30, pnl: -80, r_multiple: -1, fee: 2 }),
    makeTrade({ id: 4, exit_time: null, exit_price: null, pnl: 999, r_multiple: 9, fee: 0 }),
  ];

  const s = computeStats(trades);
  assert.equal(s.total_trades, 4);
  assert.equal(s.open_trades, 1);
  assert.equal(s.closed_trades, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 2);
  assert.equal(s.net_pnl, -30);
  assert.equal(s.max_drawdown, 130);
  assert.equal(s.total_fees, 6);
  assert.ok(Math.abs(s.win_rate - 1 / 3) < 1e-6);
});
