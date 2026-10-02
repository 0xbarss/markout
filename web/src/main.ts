import "./styles.css";
import { connectEventStream, loadAll } from "./api.ts";
import { createTerminalChart, type Ohlc } from "./chart.ts";
import { $, h } from "./dom.ts";
import { fmtPrice, fmtSigned, signClass } from "./format.ts";
import { spanOf } from "./overlays/sl_tp_trail.ts";
import { baseInterval, isResamplable, resample, TIMEFRAMES } from "./resample.ts";

import { ReplayController } from "./replay/controller.ts";
import { computeStats } from "./stats.ts";
import { initMobileDrawer } from "./ui/mobile.ts";
import { mountReplayBar } from "./ui/replay_bar.ts";
import { mountDrawingTools } from "./ui/tools.ts";
import {
  mountTradeOverlaySelector,
  renderAccount,
  renderHeaderStats,
  renderSymbol,
  renderTick,
  renderTicker,
  renderTimeframes,
} from "./ui/header.ts";
import { mountLedger } from "./ui/ledger.ts";
import { renderStats } from "./ui/panel.ts";
import type { Bar, MarketEvent, Trade } from "./types.ts";

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
  const [initialBars, initialTrades, initialStats, initialSignals] = await loadAll();
  const chart = createTerminalChart($("chart"));
  const replay = new ReplayController();
  mountReplayBar(replay);
  mountDrawingTools(chart.drawings);
  mountTradeOverlaySelector((mode) => {
    chart.setTradeOverlayMode(mode);
  });
  initMobileDrawer();

  let bars = initialBars;
  let trades = initialTrades;
  let stats = initialStats;
  let signals = initialSignals;
  let symbol = dominantSymbol(trades);
  if (symbol === "—" && signals.length > 0 && signals[0].symbol) {
    symbol = signals[0].symbol;
  }
  let overlayTrades = trades.filter((t) => t.symbol === symbol);
  let overlaySignals = signals.filter((s) => !s.symbol || s.symbol === symbol || symbol === "—");
  let view: Bar[] = bars;

  renderSymbol(symbol);
  renderHeaderStats(stats);
  renderStats(stats);

  const sigBtn = document.getElementById("signals-toggle-btn");
  if (sigBtn) {
    if (signals.length > 0) {
      sigBtn.hidden = false;
      let sigVis = true;
      sigBtn.addEventListener("click", () => {
        sigVis = !sigVis;
        sigBtn.classList.toggle("active", sigVis);
        chart.setSignalsVisible(sigVis);
      });
    } else {
      sigBtn.hidden = true;
    }
  }

  const ledger = mountLedger(
    trades,
    (t) => {
      if (!t) {
        chart.setSelectedTrade(null);
        return;
      }
      chart.setSelectedTrade(t.id);
      const span = t.symbol === symbol ? spanOf(t, view) : null;
      if (!span) return;
      const pad = Math.max(20, Math.round((span[1] - span[0]) * 0.5));
      chart.focus(span[0] - pad, span[1] + pad);
      $("chart").scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    signals,
    (s) => {
      if (!s) {
        chart.setSelectedSignal(null);
        return;
      }
      chart.setSelectedSignal(s.id);
      const bi = view.findIndex((b) => b.time >= s.time);
      if (bi >= 0) {
        chart.focus(Math.max(0, bi - 20), Math.min(view.length - 1, bi + 20));
      }
    },
  );

  replay.onFrame((frame) => {
    chart.setBars(frame.visibleBars, false);
    chart.setTrades(frame.visibleTrades, frame.visibleBars);
    chart.setSignals(frame.visibleSignals, frame.visibleBars);
    renderTicker(frame.visibleBars);
    renderLegend(null, frame.visibleBars[frame.visibleBars.length - 1]);
  });

  let base = baseInterval(bars);
  let active = TIMEFRAMES.find((t) => isResamplable(base, t.sec))?.sec ?? base;
  const apply = () => {
    if (!isResamplable(base, active)) {
      active = base;
    }
    view = active === base || base === 0 ? bars : resample(bars, active, base);
    replay.setData(view, overlayTrades, overlaySignals);
    chart.fit();
    chart.drawings.setContext(symbol, active);
    renderTimeframes(base, active, (sec) => {
      if (isResamplable(base, sec)) {
        active = sec;
        apply();
      }
    });
  };

  chart.onCrosshair((o) => {
    const visible = replay.getVisibleBars();
    renderLegend(o, visible[visible.length - 1]);
  });

  $("empty").hidden = bars.length > 0;
  apply();

  connectEventStream((event: MarketEvent) => {
    switch (event.type) {
      case "bar": {
        const b = event.data;
        if (bars.length === 0) {
          bars.push(b);
          $("empty").hidden = true;
          base = baseInterval(bars);
          active = TIMEFRAMES.find((t) => isResamplable(base, t.sec))?.sec ?? base;
          apply();
          return;
        }


        const last = bars[bars.length - 1];
        if (b.time === last.time) {
          bars[bars.length - 1] = b;
        } else if (b.time > last.time) {
          bars.push(b);
        }

        if (active === base || base === 0) {
          replay.appendOrUpdateBar(b);
        } else {
          const bucketTime = Math.floor(b.time / active) * active;
          const bucketBars = bars.filter(
            (item) => item.time >= bucketTime && item.time < bucketTime + active,
          );
          if (bucketBars.length > 0) {
            const bucketBar: Bar = {
              time: bucketTime,
              open: bucketBars[0].open,
              high: Math.max(...bucketBars.map((x) => x.high)),
              low: Math.min(...bucketBars.map((x) => x.low)),
              close: bucketBars[bucketBars.length - 1].close,
              volume: bucketBars.reduce((acc, x) => acc + x.volume, 0),
            };
            replay.appendOrUpdateBar(bucketBar);
          }
        }
        break;
      }
      case "tick": {
        const visible = replay.getVisibleBars();
        const last = visible[visible.length - 1];
        renderTick(event.data, last?.close);
        break;
      }
      case "trade": {
        const t = event.data.trade;
        const idx = trades.findIndex((x) => x.id === t.id);
        if (idx >= 0) {
          trades[idx] = t;
        } else {
          trades.push(t);
        }
        if (symbol === "—" && t.symbol) {
          symbol = t.symbol;
          renderSymbol(symbol);
          chart.drawings.setContext(symbol, active);
        }
        overlayTrades = trades.filter((x) => x.symbol === symbol);
        ledger.update(trades);
        stats = computeStats(trades);
        renderStats(stats);
        renderHeaderStats(stats);
        if (t.symbol === symbol) {
          replay.updateTrade(t);
        }
        break;
      }
      case "risk_bracket": {
        const { trade_id, stop_loss, take_profit, timestamp } = event.data;
        const tr = trades.find((x) => x.id === trade_id);
        if (tr) {
          if (take_profit !== null) tr.take_profit = take_profit;
          if (stop_loss !== null) {
            const lastPt = tr.sl_history[tr.sl_history.length - 1];
            if (lastPt && lastPt.time === timestamp) {
              lastPt.price = stop_loss;
            } else {
              tr.sl_history.push({ time: timestamp, price: stop_loss });
            }
          }
        }
        replay.updateRiskBracket(trade_id, stop_loss, take_profit, timestamp);
        break;
      }
      case "account": {
        renderAccount(event.data);
        break;
      }
      case "signal": {
        const s = event.data;
        signals.push(s);
        overlaySignals = signals.filter((x) => !x.symbol || x.symbol === symbol || symbol === "—");
        replay.setSignals(overlaySignals);
        ledger.update(trades, signals);
        if (sigBtn) sigBtn.hidden = false;
        break;
      }
    }
  });
}

main().catch((err: unknown) => {
  const el = $("error");
  el.textContent = `Failed to load data: ${err instanceof Error ? err.message : String(err)}`;
  el.hidden = false;
});
