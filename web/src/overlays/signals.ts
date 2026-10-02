import type { SeriesMarker, Time } from "lightweight-charts";
import { fmtPrice } from "../format.ts";
import type { Bar, Signal } from "../types.ts";
import { locate } from "./snap.ts";

const SIGNAL_BUY = "#00d2d3"; // Electric cyan
const SIGNAL_SELL = "#ff4757"; // Coral red

/** Signal entry arrows with strategy and entry price, snapped to bar times. */
export function buildSignalMarkers(
  signals: Signal[],
  bars: Bar[],
  compact: boolean = false,
  selectedSignalId: string | null = null,
): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  for (const s of signals) {
    if (s.direction === "hold") continue;

    const bi = locate(bars, s.time);
    if (bi < 0) continue;

    const isBuy = s.direction === "buy";
    const isSelected = s.id === selectedSignalId;
    const tag = s.strategy ? `${s.strategy} ` : "";
    const label = (!compact || isSelected)
      ? `⚡ ${tag}${isBuy ? "Buy" : "Sell"} @ ${fmtPrice(s.entry_price)}`
      : `⚡ ${tag}`;

    out.push({
      time: bars[bi].time as Time,
      position: isBuy ? "belowBar" : "aboveBar",
      shape: isBuy ? "arrowUp" : "arrowDown",
      color: isBuy ? SIGNAL_BUY : SIGNAL_SELL,
      text: label,
    });
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}
