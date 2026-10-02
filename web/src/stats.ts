import type { Stats, Trade } from "./types.ts";

export function computeStats(trades: Trade[]): Stats {
  const closed = trades.filter((t) => t.exit_time !== null);
  closed.sort((a, b) => ((a.exit_time ?? 0) - (b.exit_time ?? 0)) || a.id - b.id);
  const n = closed.length;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  let totalFees = 0;
  let sumR = 0;

  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (t.pnl > 0) wins++;
    else if (t.pnl < 0) losses++;
    netPnl += t.pnl;
    totalFees += t.fee;
    sumR += t.r_multiple;
  }

  return {
    total_trades: trades.length,
    open_trades: trades.length - n,
    closed_trades: n,
    wins,
    losses,
    win_rate: n > 0 ? wins / n : 0,
    net_pnl: netPnl,
    total_fees: totalFees,
    avg_r: n > 0 ? sumR / n : 0,
    max_drawdown: maxDd,
  };
}
