import { $, h } from "../dom";
import { fmtPrice, fmtSigned, signClass } from "../format";
import { TIMEFRAMES } from "../resample";
import type { Bar, Stats } from "../types";

export function renderSymbol(symbol: string): void {
  $("symbol").textContent = symbol;
}

/** Timeframe pills; those finer than the data's native interval are disabled. */
export function renderTimeframes(base: number, active: number, onSelect: (sec: number) => void): void {
  const el = $("tf-pills");
  el.replaceChildren();
  for (const tf of TIMEFRAMES) {
    const b = h("button", tf.sec === active ? "active" : "", tf.label);
    b.disabled = base === 0 || tf.sec < base;
    b.addEventListener("click", () => onSelect(tf.sec));
    el.append(b);
  }
}

export function renderTicker(bars: Bar[]): void {
  const last = bars[bars.length - 1];
  if (!last) return;
  const prev = bars[bars.length - 2];
  $("last-price").textContent = fmtPrice(last.close);
  if (prev && prev.close !== 0) {
    const pct = ((last.close - prev.close) / prev.close) * 100;
    const chg = $("last-change");
    chg.textContent = `${fmtSigned(pct)}%`;
    chg.className = `chg ${signClass(pct)}`;
  }
}

export function renderHeaderStats(stats: Stats): void {
  const pnl = $("pnl");
  pnl.textContent = fmtSigned(stats.net_pnl, 2, "$");
  pnl.className = signClass(stats.net_pnl);
  // Equity needs account events (live mode), so it stays blank for now.
  $("equity").textContent = "—";
}
