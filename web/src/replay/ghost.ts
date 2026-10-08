import type { Bar, Signal, Stats, Trade } from "../types.ts";
import { computeStats } from "../stats.ts";

/**
 * Filter and clip trades for ghost mode up to the current visible bars.
 * Trades entering after the current bar are omitted to eliminate hindsight bias.
 * Trades currently open have their exit concealed, stop history clipped,
 * and final outcome metrics masked.
 */
export function clipTradesForReplay(trades: Trade[], visibleBars: Bar[]): Trade[] {
  if (visibleBars.length === 0) return [];
  const currentBar = visibleBars[visibleBars.length - 1];
  const out: Trade[] = [];

  for (const t of trades) {
    if (t.entry_time > currentBar.time) {
      continue;
    }

    if (t.exit_time !== null && t.exit_time <= currentBar.time) {
      out.push(t);
    } else {
      const slHistory = t.sl_history.filter((p) => p.time <= currentBar.time);
      out.push({
        ...t,
        exit_time: null,
        exit_price: null,
        exit_reason: null,
        sl_history: slHistory,
        pnl: 0,
        r_multiple: 0,
        fee: 0,
        mae_pct: null,
        mfe_pct: null,
      });
    }
  }

  return out;
}

export interface ReplayFrameLike {
  visibleBars: Bar[];
  visibleTrades: Trade[];
  visibleSignals: Signal[];
  isLive?: boolean;
}

export interface PanelModel {
  stats: Stats;
  visibleTrades: Trade[];
  visibleSignals: Signal[];
}

export function panelModel(frame: ReplayFrameLike): PanelModel {
  const stats = computeStats(frame.visibleTrades);
  return {
    stats,
    visibleTrades: frame.visibleTrades,
    visibleSignals: frame.visibleSignals,
  };
}

