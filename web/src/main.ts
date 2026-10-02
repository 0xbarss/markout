import "./styles.css";
import { loadAll } from "./api";
import { createTerminalChart, type Ohlc } from "./chart";
import { $, h } from "./dom";
import { fmtPrice, fmtSigned, signClass } from "./format";
import { spanOf } from "./overlays/sl_tp_trail";
import { baseInterval, resample, TIMEFRAMES } from "./resample";
import { renderHeaderStats, renderSymbol, renderTicker, renderTimeframes } from "./ui/header";
import { mountLedger } from "./ui/ledger";
import { renderStats } from "./ui/panel";
import type { Bar, Trade } from "./types";

function renderLegend(o: Ohlc | null, fallback: Bar | undefined): void {
  const src = o ?? fallback;
  const legend = $("legend");
  legend.replaceChildren();
  if (!src) return;
  const pct = src.open ? ((src.close - src.open) / src.open) * 100 : 0;
  const cls = signClass(pct);
  for (const [k, v] of [["O", src.open], ["H", src.high], ["L", src.low], ["C", src.close]] as [string, number][]) {
    legend.append(h("span", cls, `${k} ${fmtPrice(v)}`));
  }
  legend.append(h("span", cls, `${fmtSigned(pct)}%`));
}

/** The symbol with the most trades; the bars are assumed to belong to it. */
function dominantSymbol(trades: Trade[]): string {
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
  let best = "—", n = 0;
  for (const [sym, c] of counts) if (c > n) { best = sym; n = c; }
  return best;
}

async function main(): Promise<void> {
  const [bars, trades, stats] = await loadAll();
  const chart = createTerminalChart($("chart"));

  const symbol = dominantSymbol(trades);
  const overlayTrades = trades.filter((t) => t.symbol === symbol);
  let view: Bar[] = bars;

  renderSymbol(symbol);
  renderHeaderStats(stats);
  renderStats(stats);
  mountLedger(trades, (t) => {
    const span = t.symbol === symbol ? spanOf(t, view) : null;
    if (!span) return;
    const pad = Math.max(20, Math.round((span[1] - span[0]) * 0.5));
    chart.focus(span[0] - pad, span[1] + pad);
    $("chart").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  const base = baseInterval(bars);
  // Start on the native timeframe: the first pill at or above the data's interval.
  let active = TIMEFRAMES.find((t) => t.sec >= base)?.sec ?? 0;
  const apply = () => {
    view = active === base || base === 0 ? bars : resample(bars, active);
    chart.setBars(view);
    chart.setTrades(overlayTrades, view);
    renderTicker(view);
    renderLegend(null, view[view.length - 1]);
    renderTimeframes(base, active, (sec) => { active = sec; apply(); });
  };

  chart.onCrosshair((o) => renderLegend(o, view[view.length - 1]));
  $("empty").hidden = bars.length > 0;
  apply();
}

main().catch((err: unknown) => {
  const el = $("error");
  el.textContent = `Failed to load data: ${err instanceof Error ? err.message : String(err)}`;
  el.hidden = false;
});
