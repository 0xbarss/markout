import "./styles.css";
import { connectEventStream, loadAll } from "./api.ts";
import { createTerminalChart, type Ohlc } from "./chart.ts";
import { $, h } from "./dom.ts";
import { fmtPrice, fmtSigned, signClass } from "./format.ts";
import { spanOf } from "./overlays/sl_tp_trail.ts";
import { baseInterval, isResamplable, parseTimeframe, resample } from "./resample.ts";
import { LiveState } from "./live.ts";

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
  setBarCountdownContext,
} from "./ui/header.ts";
import { mountLedger } from "./ui/ledger.ts";
import { renderStats } from "./ui/panel.ts";
import type { Bar, MarketEvent, Trade } from "./types.ts";

function renderLegend(o: Ohlc | null, fallback: Bar | undefined, notice?: string | null): void {
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
  if (notice) {
    legend.append(h("span", "muted", notice));
  }
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
  const [initialBars, initialTrades, initialStats, initialSignals, health] = await loadAll();
  const chart = createTerminalChart($("chart"));
  const replay = new ReplayController();
  const replayBar = mountReplayBar(replay);
  mountDrawingTools(chart.drawings);
  mountTradeOverlaySelector((mode) => {
    chart.setTradeOverlayMode(mode);
  });
  initMobileDrawer();

  // Empty state copy command button
  const copyBtn = document.getElementById("empty-copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const code = document.getElementById("empty-code")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      } catch {
        // fallback
      }
    });
  }

  // Selected trade card
  function updateTradeCard(t: Trade | null): void {
    const card = $("selected-trade-card");
    if (!t) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $("tc-id").textContent = `#${t.id}`;
    const sideEl = $("tc-side");
    sideEl.textContent = t.direction === "buy" ? "Long" : "Short";
    sideEl.className = `trade-card-badge ${t.direction}`;
    $("tc-sym").textContent = t.symbol;
    $("tc-entry").textContent = fmtPrice(t.entry_price);
    $("tc-exit").textContent = t.exit_price !== null ? fmtPrice(t.exit_price) : "Open";
    const pnlEl = $("tc-pnl");
    pnlEl.textContent = t.exit_time !== null ? fmtSigned(t.pnl, 2, "$") : "—";
    pnlEl.className = `trade-card-val ${signClass(t.pnl)}`;
    const rEl = $("tc-r");
    rEl.textContent = t.exit_time !== null ? `${fmtSigned(t.r_multiple, 2)} R` : "—";
    rEl.className = `trade-card-val ${signClass(t.r_multiple)}`;
    const mae = t.mae_pct !== null && !isNaN(t.mae_pct) ? `${fmtSigned(t.mae_pct, 2)}%` : "—";
    const mfe = t.mfe_pct !== null && !isNaN(t.mfe_pct) ? `${fmtSigned(t.mfe_pct, 2)}%` : "—";
    $("tc-mae-mfe").textContent = `${mae} / ${mfe}`;
    const trailCount = t.sl_history.length;
    const reasonText = t.exit_reason ? t.exit_reason.replace(/_/g, " ") : (t.exit_time ? "exit" : "open");
    $("tc-reason").textContent = trailCount > 0 ? `${reasonText} (${trailCount} stop moves)` : reasonText;
  }

  let selectedTradeId: number | null = null;
  const refreshSelectedTrade = (visibleTrades: Trade[]) => {
    if (selectedTradeId === null) return;
    const current = visibleTrades.find((t) => t.id === selectedTradeId);
    if (!current) {
      selectedTradeId = null;
      chart.setSelectedTrade(null);
      updateTradeCard(null);
    } else {
      updateTradeCard(current);
    }
  };

  $("tc-close")?.addEventListener("click", () => {
    selectedTradeId = null;
    chart.setSelectedTrade(null);
    updateTradeCard(null);
  });

  let bars = initialBars;
  let trades = initialTrades;
  let stats = initialStats;
  let signals = initialSignals;
  let symbol = dominantSymbol(trades);
  if (symbol === "—" && signals.length > 0 && signals[0].symbol) {
    symbol = signals[0].symbol;
  }
  if (symbol === "—" && health.symbol) {
    symbol = health.symbol;
  }
  let overlayTrades = trades.filter((t) => t.symbol === symbol);
  let overlaySignals = signals.filter((s) => !s.symbol || s.symbol === symbol || symbol === "—");
  let view: Bar[] = bars;

  renderSymbol(symbol);
  chart.setSymbol(symbol);
  renderHeaderStats(stats);
  renderStats(stats, trades);

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
        selectedTradeId = null;
        chart.setSelectedTrade(null);
        updateTradeCard(null);
        return;
      }
      selectedTradeId = t.id;
      chart.setSelectedTrade(t.id);
      const visibleT = replay.getVisibleTrades().find((x) => x.id === t.id) ?? t;
      updateTradeCard(visibleT);
      const span = t.symbol === symbol ? spanOf(t, view) : null;
      if (!span) return;
      const pad = Math.max(20, Math.round((span[1] - span[0]) * 0.5));
      const cursor = replay.getCursor();
      const maxBar = Math.min(span[1], cursor);
      chart.focus(Math.max(0, span[0] - pad), Math.min(view.length - 1, maxBar + pad));
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

  let configuredBase = 0;
  if (typeof window !== "undefined" && window.location) {
    const params = new URLSearchParams(window.location.search);
    const paramTf = params.get("tf");
    if (paramTf) {
      const parsed = parseTimeframe(paramTf);
      if (parsed) configuredBase = parsed;
    }
  }
  if (configuredBase === 0 && health.tf) {
    configuredBase = health.tf;
  }

  let initialBase = baseInterval(bars);
  if (initialBase === 0 && configuredBase > 0) {
    initialBase = configuredBase;
  }

  const liveState = new LiveState({ initialBase });

  function tradesKey(tradesList: Trade[]): string {
    return tradesList.map((t) => `${t.id}:${t.exit_time !== null ? 1 : 0}`).join(",");
  }

  let lastPanelKey = "";

  replay.onFrame((frame) => {
    chart.setBars(frame.visibleBars, false);
    chart.setTrades(frame.visibleTrades, frame.visibleBars);
    chart.setSignals(frame.visibleSignals, frame.visibleBars);

    const isLive = frame.isLive;
    const currentTrades = isLive ? overlayTrades : frame.visibleTrades;
    const currentSignals = isLive ? overlaySignals : frame.visibleSignals;
    const key = (isLive ? "live:" : "ghost:") + tradesKey(currentTrades) + "|" + currentSignals.length;

    if (key !== lastPanelKey) {
      lastPanelKey = key;
      const s = isLive ? stats : computeStats(currentTrades);
      ledger.update(currentTrades, currentSignals);
      renderStats(s, currentTrades);
      renderHeaderStats(s);
      refreshSelectedTrade(currentTrades);
    }

    renderTicker(frame.visibleBars);
    const latestBar = frame.visibleBars[frame.visibleBars.length - 1];
    setBarCountdownContext(latestBar ? latestBar.time : null, liveState.getActive(), health.mode === "live");
    renderLegend(null, latestBar, chart.getOverlayNotice());
  });
  const apply = () => {
    const base = liveState.getBase();
    let active = liveState.getActive();
    if (base > 0 && !isResamplable(base, active)) {
      active = base;
      liveState.setActive(base);
    }
    const currentVisible = replay.getVisibleBars();
    const preserveTime =
      currentVisible.length > 0 ? currentVisible[currentVisible.length - 1].time : null;
    view = active === base || base === 0 ? bars.slice() : resample(bars, active, base);
    lastPanelKey = "";
    replay.setData(view, overlayTrades, overlaySignals, preserveTime);
    replayBar.setTrades(overlayTrades, view);
    chart.fit();
    const latestBar = view[view.length - 1];
    setBarCountdownContext(latestBar ? latestBar.time : null, active, health.mode === "live");
    chart.drawings.setContext(symbol, active);
    renderTimeframes(base, active, (sec) => {
      if (liveState.setActive(sec)) {
        apply();
      }
    });
  };

  let lastCrosshairOhlc: Ohlc | null = null;
  chart.onCrosshair((o) => {
    lastCrosshairOhlc = o;
    const visible = replay.getVisibleBars();
    renderLegend(o, visible[visible.length - 1], chart.getOverlayNotice());
  });

  chart.onOverlayNoticeChange((notice) => {
    const visible = replay.getVisibleBars();
    renderLegend(lastCrosshairOhlc, visible[visible.length - 1], notice);
  });

  $("empty").hidden = bars.length > 0;
  apply();

  connectEventStream((event: MarketEvent) => {
    switch (event.type) {
      case "bar": {
        const b = event.data;
        const wasEmpty = bars.length === 0;
        const { updatedBar, needsReapply } = liveState.onBar(bars, b);

        if (wasEmpty) {
          $("empty").hidden = true;
          apply();
          return;
        }

        if (needsReapply) {
          apply();
        } else {
          replay.appendOrUpdateBar(updatedBar);
        }
        break;
      }
      case "tick": {
        if (symbol === "—" && event.data.symbol) {
          symbol = event.data.symbol;
          renderSymbol(symbol);
          chart.setSymbol(symbol);
        }
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
          chart.setSymbol(symbol);
          chart.drawings.setContext(symbol, liveState.getActive());
        }
        overlayTrades = trades.filter((x) => x.symbol === symbol);
        ledger.update(trades);
        stats = computeStats(trades);
        renderStats(stats, trades);
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
  const msg = err instanceof Error ? err.message : String(err);
  el.replaceChildren();
  const title = h("div");
  const strong = h("strong", "", "Failed to load data: ");
  title.append(strong, document.createTextNode(msg));
  const hint = h("div", "error-hint");
  hint.append(
    document.createTextNode("Check if the server is running on the expected port or verify input files with "),
    h("code", "", "--bars <path> --db <path>"),
    document.createTextNode("."),
  );
  el.append(title, hint);
  el.hidden = false;
});
