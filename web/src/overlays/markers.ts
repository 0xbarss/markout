import type { SeriesMarker, Time } from "lightweight-charts";
import { fmtPrice, fmtSigned } from "../format.ts";
import type { Bar, ExitReason, Trade } from "../types";
import { locate } from "./snap.ts";

const UP = "#0ecb81", DOWN = "#f6465d", FLAT = "#848e9c";

const REASON: Record<ExitReason, string> = {
  take_profit: "TP", trailing_stop: "TS", initial_stop: "SL", signal: "Sig", manual: "Man",
};

/** Entry arrows and exit dots, snapped to bar times and sorted ascending. */
export function buildMarkers(
  trades: Trade[],
  bars: Bar[],
  compactAll: boolean = false,
  selectedTradeId: number | null = null,
): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  for (const t of trades) {
    const isSelected = t.id === selectedTradeId;
    const long = t.direction === "buy";
    const ei = locate(bars, t.entry_time);
    if (ei >= 0) {
      const showText = !compactAll || isSelected;
      out.push({
        time: bars[ei].time as Time,
        position: long ? "belowBar" : "aboveBar",
        shape: long ? "arrowUp" : "arrowDown",
        color: long ? UP : DOWN,
        text: showText ? `${long ? "Buy" : "Sell"} @ ${fmtPrice(t.entry_price)}` : "",
      });
    }
    if (t.exit_time !== null) {
      const xi = locate(bars, t.exit_time);
      if (xi >= 0) {
        const tag = t.exit_reason ? `${REASON[t.exit_reason]} ` : "";
        const label = (!compactAll || isSelected)
          ? `${tag}${fmtSigned(t.r_multiple, 2)}R`
          : `${fmtSigned(t.r_multiple, 1)}R`;
        out.push({
          time: bars[xi].time as Time,
          position: "inBar",
          shape: "circle",
          color: t.pnl > 0 ? UP : t.pnl < 0 ? DOWN : FLAT,
          text: label,
        });
      }
    }
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}
