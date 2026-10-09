import {
  ColorType, CrosshairMode, LineStyle, LineType, createChart,
  type CandlestickData, type Coordinate, type ISeriesApi, type LineData, type UTCTimestamp, type WhitespaceData,
} from "lightweight-charts";
import { DrawingManager } from "./drawings/manager.ts";
import type { CoordinateConverter } from "./drawings/types.ts";
import { precisionFor } from "./format.ts";
import { buildMarkers } from "./overlays/markers.ts";
import { buildSignalMarkers } from "./overlays/signals.ts";
import { barIndexAt, locate } from "./overlays/snap.ts";
import { buildTrail, syncLanes, type TrailPoint } from "./overlays/sl_tp_trail.ts";
import type { Bar, Signal, Trade } from "./types.ts";
import { DrawingFloatingToolbar } from "./ui/drawing_toolbar.ts";

import { getThemeTokens, hexToRgba } from "./theme.ts";

export interface Ohlc { open: number; high: number; low: number; close: number; }

export type TradeOverlayMode = "focus" | "all" | "off";

/** Maximum number of open trades to render trailing stop/target overlay lanes for in focus mode. */
export const MAX_FOCUS_OPEN_TRADES = 20;

/** Maximum number of overlay lanes (series) to create in "all" mode to prevent performance degradation. */
export const MAX_ALL_LANES = 200;

export interface TerminalChart {
  setBars(bars: Bar[], fit?: boolean): void;
  fit(): void;
  /** Draw entry/exit markers and SL/TP paths for `trades` against the bars currently shown. */
  setTrades(trades: Trade[], bars: Bar[]): void;
  setTradeOverlayMode(mode: TradeOverlayMode): void;
  setSelectedTrade(tradeId: number | null): void;
  /** Set symbol for display and accessibility */
  setSymbol(symbol: string): void;
  /** Strategy signals display */
  setSignals(signals: Signal[], bars: Bar[]): void;
  setSignalsVisible(visible: boolean): void;
  setSelectedSignal(signalId: string | null): void;
  /** Show bar indices [from, to] (relative to the bars passed to setBars). */
  focus(from: number, to: number): void;
  onCrosshair(cb: (ohlc: Ohlc | null) => void): void;
  drawings: DrawingManager;
  setAutoScale(auto: boolean): void;
  isAutoScale(): boolean;
  onAutoScaleChange(cb: (auto: boolean) => void): () => void;
  getOverlayNotice(): string | null;
  onOverlayNoticeChange(cb: (notice: string | null) => void): () => void;
}

export function createTerminalChart(container: HTMLElement): TerminalChart {
  const tokens = getThemeTokens();
  const UP = tokens.up;
  const DOWN = tokens.down;

  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: tokens.bg }, textColor: tokens.muted },
    grid: { vertLines: { color: tokens.border }, horzLines: { color: tokens.border } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: tokens.border2, autoScale: false },
    timeScale: { borderColor: tokens.border2, timeVisible: true, secondsVisible: false },
  });

  const candles = chart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
  });
  const volume = chart.addHistogramSeries({
    priceFormat: { type: "volume" }, priceScaleId: "volume",
  });
  chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  // One line series per "lane" of non-overlapping trades, so hundreds of trades stay cheap.
  const slLanes: ISeriesApi<"Line">[] = [];
  const tpLanes: ISeriesApi<"Line">[] = [];
  const lineOpts = { lineWidth: 1 as const, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
  const makeSl = () => chart.addLineSeries({ ...lineOpts, color: DOWN, lineStyle: LineStyle.Dashed, lineType: LineType.WithSteps });
  const makeTp = () => chart.addLineSeries({ ...lineOpts, color: UP, lineStyle: LineStyle.Dotted });
  const tradeConnector = chart.addLineSeries({
    lineWidth: 1 as const,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  const signalSlLine = chart.addLineSeries({
    ...lineOpts,
    color: DOWN,
    lineStyle: LineStyle.Dashed,
  });
  const signalTpLine = chart.addLineSeries({
    ...lineOpts,
    color: UP,
    lineStyle: LineStyle.Dotted,
  });
  const toData = (pts: TrailPoint[]): (LineData | WhitespaceData)[] =>
    pts.map((p) => p.value === undefined
      ? { time: p.time as UTCTimestamp }
      : { time: p.time as UTCTimestamp, value: p.value });
  const sync = (pool: ISeriesApi<"Line">[], lanes: TrailPoint[][], make: () => ISeriesApi<"Line">) => {
    syncLanes(pool, lanes, make, (s) => chart.removeSeries(s), toData);
  };

  const drawingCanvas = document.createElement("canvas");
  drawingCanvas.className = "drawing-canvas";
  drawingCanvas.setAttribute("aria-label", "Chart drawing overlay");
  drawingCanvas.setAttribute("role", "img");
  container.style.position = "relative";
  container.setAttribute("role", "region");
  container.appendChild(drawingCanvas);

  let currentSymbol = "";
  const updateAriaLabel = () => {
    if (currentBars.length === 0) {
      container.setAttribute("aria-label", currentSymbol ? `${currentSymbol} chart: no data` : "Chart: no data");
      return;
    }
    const first = currentBars[0];
    const last = currentBars[currentBars.length - 1];
    const d1 = new Date(first.time * 1000).toISOString().slice(0, 10);
    const d2 = new Date(last.time * 1000).toISOString().slice(0, 10);
    const sym = currentSymbol || "Price";
    const p = precisionFor(last.close);
    container.setAttribute(
      "aria-label",
      `${sym} chart from ${d1} to ${d2}, last price ${p > 0 ? last.close.toFixed(p) : last.close}`
    );
  };

  let currentBars: Bar[] = [];
  let lastTrades: Trade[] = [];
  let lastSignals: Signal[] = [];
  let signalsVisible: boolean = true;
  let currentOverlayMode: TradeOverlayMode = "focus";
  let currentSelectedTradeId: number | null = null;
  let currentSelectedSignalId: string | null = null;
  const conv: CoordinateConverter = {
    timeToX: (t) => chart.timeScale().timeToCoordinate(t as UTCTimestamp),
    xToTime: (x) => chart.timeScale().coordinateToTime(x as Coordinate) as number | null,
    priceToY: (p) => candles.priceToCoordinate(p),
    yToPrice: (y) => candles.coordinateToPrice(y as Coordinate) as number | null,
    snapPoint: (x, y) => {
      if (currentBars.length === 0) return null;
      const t = chart.timeScale().coordinateToTime(x as Coordinate) as number | null;
      if (t === null) return null;
      const bi = barIndexAt(currentBars, t);
      if (bi < 0 || bi >= currentBars.length) return null;
      const b = currentBars[bi];
      const bx = chart.timeScale().timeToCoordinate(b.time as UTCTimestamp);
      if (bx === null || Math.abs(bx - x) > 24) return null;
      const py = candles.coordinateToPrice(y as Coordinate);
      if (py === null) return null;
      const levels = [b.high, b.low, b.open, b.close];
      let bestPrice = levels[0];
      let bestDist = Math.abs(bestPrice - py);
      for (let i = 1; i < levels.length; i++) {
        const dist = Math.abs(levels[i] - py);
        if (dist < bestDist) {
          bestDist = dist;
          bestPrice = levels[i];
        }
      }
      const wickY = candles.priceToCoordinate(bestPrice);
      if (wickY === null || Math.abs(wickY - y) > 24) return null;
      return { time: b.time, price: bestPrice };
    },
    getBarCount: (t1, t2) => {
      if (currentBars.length === 0) return null;
      const minT = Math.min(t1, t2);
      const maxT = Math.max(t1, t2);
      const i1 = barIndexAt(currentBars, minT);
      const i2 = barIndexAt(currentBars, maxT);
      if (i1 < 0 || i2 < 0) return null;
      return Math.abs(i2 - i1) + 1;
    },
    getRangeVolume: (t1, t2) => {
      if (currentBars.length === 0) return null;
      const minT = Math.min(t1, t2);
      const maxT = Math.max(t1, t2);
      const i1 = Math.max(0, barIndexAt(currentBars, minT));
      const i2 = Math.min(currentBars.length - 1, barIndexAt(currentBars, maxT));
      if (i1 < 0 || i2 < 0) return null;
      let sum = 0;
      for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) {
        sum += currentBars[i].volume ?? 0;
      }
      return sum;
    },
  };

  const drawings = new DrawingManager(drawingCanvas, conv);
  const floatingToolbar = new DrawingFloatingToolbar(container, drawings);

  // Auto scale (fits data to screen) under price column - default to closed
  const axisCorner = document.createElement("div");
  axisCorner.className = "chart-axis-corner";
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "chart-auto-btn";
  autoBtn.title = "Auto (fits data to screen) [Alt+A]";
  autoBtn.textContent = "auto";
  axisCorner.appendChild(autoBtn);
  container.appendChild(axisCorner);

  let autoScale = false; // default to closed
  let isInitializing = true;
  let hasInitializedScale = false;
  const autoScaleListeners = new Set<(auto: boolean) => void>();

  const updateAutoBtn = () => {
    autoBtn.classList.toggle("active", autoScale);
  };
  updateAutoBtn();

  const setAutoScale = (enabled: boolean) => {
    autoScale = enabled;
    chart.priceScale("right").applyOptions({ autoScale: enabled });
    updateAutoBtn();
    for (const cb of autoScaleListeners) {
      cb(autoScale);
    }
  };

  autoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setAutoScale(!autoScale);
  });

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAutoScale(!autoScale);
    }
  });

  let currentOverlayNotice: string | null = null;
  const overlayNoticeListeners = new Set<(notice: string | null) => void>();
  const setOverlayNotice = (notice: string | null) => {
    if (notice !== currentOverlayNotice) {
      currentOverlayNotice = notice;
      for (const cb of overlayNoticeListeners) {
        cb(currentOverlayNotice);
      }
    }
  };

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    drawings.render();
    floatingToolbar.updatePosition();
    updateTradeOverlays();
    if (!isInitializing) {
      const opts = chart.priceScale("right").options();
      if (opts.autoScale !== undefined && opts.autoScale !== autoScale) {
        autoScale = opts.autoScale;
        updateAutoBtn();
        for (const cb of autoScaleListeners) {
          cb(autoScale);
        }
      }
    }
  });
  chart.timeScale().subscribeVisibleTimeRangeChange(() => {
    drawings.render();
    floatingToolbar.updatePosition();
  });
  window.addEventListener("resize", () => {
    drawings.resize();
    floatingToolbar.updatePosition();
  });
  requestAnimationFrame(() => {
    drawings.resize();
    floatingToolbar.updatePosition();
  });

  return {
    drawings,
    setAutoScale,
    isAutoScale: () => autoScale,
    onAutoScaleChange(cb: (auto: boolean) => void) {
      autoScaleListeners.add(cb);
      cb(autoScale);
      return () => autoScaleListeners.delete(cb);
    },
    getOverlayNotice: () => currentOverlayNotice,
    onOverlayNoticeChange(cb: (notice: string | null) => void) {
      overlayNoticeListeners.add(cb);
      cb(currentOverlayNotice);
      return () => overlayNoticeListeners.delete(cb);
    },

    setSymbol(symbol: string) {
      currentSymbol = symbol;
      updateAriaLabel();
    },

    setBars(bars, fit = false) {
      if (bars.length === 0) {
        currentBars = [];
        candles.setData([]);
        volume.setData([]);
        updateAriaLabel();
        return;
      }

      const prevBars = currentBars;
      currentBars = bars;

      const p = precisionFor(bars[bars.length - 1].close);
      candles.applyOptions({ priceFormat: { type: "price", precision: p, minMove: 1 / 10 ** p } });

      const lastBar = bars[bars.length - 1];
      const candleItem = {
        time: lastBar.time as UTCTimestamp,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
      };
      const volumeItem = {
        time: lastBar.time as UTCTimestamp,
        value: lastBar.volume,
        color: lastBar.close >= lastBar.open ? hexToRgba(UP, 0.4) : hexToRgba(DOWN, 0.4),
      };



      // Real-time update: same candle updated in-place
      if (
        prevBars.length === bars.length &&
        prevBars.length > 0 &&
        prevBars[prevBars.length - 1].time === lastBar.time
      ) {
        candles.update(candleItem);
        volume.update(volumeItem);
        drawings.render();
        updateAriaLabel();
        return;
      }

      // Real-time append: single new candle added
      if (
        prevBars.length + 1 === bars.length &&
        prevBars.length > 0 &&
        prevBars[prevBars.length - 1].time < lastBar.time
      ) {
        // Finalize previous closed bar
        if (bars.length >= 2) {
          const prev = bars[bars.length - 2];
          candles.update({
            time: prev.time as UTCTimestamp,
            open: prev.open,
            high: prev.high,
            low: prev.low,
            close: prev.close,
          });
          volume.update({
            time: prev.time as UTCTimestamp,
            value: prev.volume,
            color: prev.close >= prev.open ? hexToRgba(UP, 0.4) : hexToRgba(DOWN, 0.4),
          });
        }
        candles.update(candleItem);
        volume.update(volumeItem);
        drawings.render();
        return;
      }

      // Forward steps in replay: up to 5 candles added consecutively
      if (
        bars.length > prevBars.length &&
        bars.length <= prevBars.length + 5 &&
        prevBars.length > 0 &&
        prevBars[prevBars.length - 1].time === bars[prevBars.length - 1].time
      ) {
        for (let i = prevBars.length; i < bars.length; i++) {
          const b = bars[i];
          candles.update({
            time: b.time as UTCTimestamp,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          });
          volume.update({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? hexToRgba(UP, 0.4) : hexToRgba(DOWN, 0.4),
          });
        }
        drawings.render();
        updateAriaLabel();
        return;
      }

      const timeScale = chart.timeScale();
      const prevRange = timeScale.getVisibleLogicalRange();

      // Full series replacement (timeframe switch, initial data, seek)
      candles.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      volume.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, value: b.volume,
        color: b.close >= b.open ? hexToRgba(UP, 0.4) : hexToRgba(DOWN, 0.4),
      })));

      if (!hasInitializedScale) {
        timeScale.fitContent();
        chart.priceScale("right").applyOptions({ autoScale: false });
        hasInitializedScale = true;
        isInitializing = false;
        autoScale = false;
        updateAutoBtn();
      } else if (fit) {
        timeScale.fitContent();
      } else if (prevRange) {
        timeScale.setVisibleLogicalRange(prevRange);
      }
      drawings.render();
      updateAriaLabel();
    },

    fit() {
      chart.timeScale().fitContent();
      if (autoScale) {
        chart.priceScale("right").applyOptions({ autoScale: true });
      }
    },


    setTrades(trades, bars) {
      lastTrades = trades;
      currentBars = bars;
      updateTradeOverlays();
    },

    setTradeOverlayMode(mode) {
      currentOverlayMode = mode;
      updateTradeOverlays();
    },

    setSelectedTrade(tradeId) {
      currentSelectedTradeId = tradeId;
      updateTradeOverlays();
    },

    setSignals(signals, bars) {
      lastSignals = signals;
      currentBars = bars;
      updateTradeOverlays();
    },

    setSignalsVisible(visible) {
      signalsVisible = visible;
      updateTradeOverlays();
    },

    setSelectedSignal(signalId) {
      currentSelectedSignalId = signalId;
      updateTradeOverlays();
    },

    focus(from, to) {
      chart.timeScale().setVisibleLogicalRange({ from, to });
    },
    onCrosshair(cb) {
      chart.subscribeCrosshairMove((param) => {
        const d = param.seriesData.get(candles) as CandlestickData | undefined;
        cb(d ? { open: d.open, high: d.high, low: d.low, close: d.close } : null);
      });
    },
  };

  function updateTradeOverlays(): void {
    if (currentBars.length === 0) {
      candles.setMarkers([]);
      tradeConnector.setData([]);
      signalSlLine.setData([]);
      signalTpLine.setData([]);
      sync(slLanes, [], makeSl);
      sync(tpLanes, [], makeTp);
      setOverlayNotice(null);
      return;
    }

    let tradeMarkers: ReturnType<typeof buildMarkers> = [];
    const visibleRange = chart.timeScale().getVisibleLogicalRange();

    if (currentOverlayMode === "off") {
      tradeConnector.setData([]);
      sync(slLanes, [], makeSl);
      sync(tpLanes, [], makeTp);
      setOverlayNotice(null);
    } else if (currentOverlayMode === "focus") {
      let focused: Trade[] = [];
      let extraCount = 0;
      const openTrades = lastTrades.filter((t) => t.exit_time === null);
      if (currentSelectedTradeId !== null) {
        const found = lastTrades.find((t) => t.id === currentSelectedTradeId);
        if (found) {
          if (found.exit_time !== null) {
            const recentOpen = openTrades.slice(-MAX_FOCUS_OPEN_TRADES);
            focused = [found, ...recentOpen];
            if (openTrades.length > MAX_FOCUS_OPEN_TRADES) {
              extraCount = openTrades.length - MAX_FOCUS_OPEN_TRADES;
            }
          } else {
            const otherOpen = openTrades.filter((t) => t.id !== found.id);
            focused = [found, ...otherOpen.slice(-(MAX_FOCUS_OPEN_TRADES - 1))];
            if (openTrades.length > MAX_FOCUS_OPEN_TRADES) {
              extraCount = openTrades.length - MAX_FOCUS_OPEN_TRADES;
            }
          }
        }
      }
      if (focused.length === 0) {
        if (openTrades.length > MAX_FOCUS_OPEN_TRADES) {
          focused = openTrades.slice(-MAX_FOCUS_OPEN_TRADES);
          extraCount = openTrades.length - MAX_FOCUS_OPEN_TRADES;
        } else {
          focused = openTrades;
        }
      }

      setOverlayNotice(extraCount > 0 ? `+${extraCount.toLocaleString()} more open` : null);

      tradeMarkers = buildMarkers(focused, currentBars, false, currentSelectedTradeId);
      const trail = buildTrail(focused, currentBars, undefined, visibleRange);
      sync(slLanes, trail.sl, makeSl);
      sync(tpLanes, trail.tp, makeTp);

      if (focused.length >= 1 && focused[0].id === currentSelectedTradeId && focused[0].exit_time !== null) {
        const ft = focused[0];
        const exitTime = ft.exit_time;
        if (exitTime !== null) {
          const ei = locate(currentBars, ft.entry_time);
          const xi = locate(currentBars, exitTime);
          if (ei >= 0 && xi >= 0 && ei !== xi) {
            tradeConnector.applyOptions({
              color: ft.pnl >= 0 ? hexToRgba(UP, 0.7) : hexToRgba(DOWN, 0.7),
            });
            tradeConnector.setData([
              { time: currentBars[ei].time as UTCTimestamp, value: ft.entry_price },
              { time: currentBars[xi].time as UTCTimestamp, value: ft.exit_price ?? ft.entry_price },
            ]);
          } else {
            tradeConnector.setData([]);
          }
        } else {
          tradeConnector.setData([]);
        }
      } else {
        tradeConnector.setData([]);
      }
    } else {
      // "all" mode
      tradeConnector.setData([]);
      tradeMarkers = buildMarkers(lastTrades, currentBars, true, currentSelectedTradeId);
      const trail = buildTrail(lastTrades, currentBars, MAX_ALL_LANES, visibleRange);
      sync(slLanes, trail.sl, makeSl);
      sync(tpLanes, trail.tp, makeTp);
      setOverlayNotice(
        trail.capped
          ? `+${(trail.cappedCount ?? 0).toLocaleString()} trails hidden (max ${MAX_ALL_LANES} lanes)`
          : null,
      );
    }

    // Signals markers
    const signalMarkers = (signalsVisible && lastSignals.length > 0)
      ? buildSignalMarkers(lastSignals, currentBars, false, currentSelectedSignalId)
      : [];

    const allMarkers = [...tradeMarkers, ...signalMarkers].sort(
      (a, b) => (a.time as number) - (b.time as number),
    );
    candles.setMarkers(allMarkers);

    // Selected signal bracket lines
    if (signalsVisible && currentSelectedSignalId !== null) {
      const sig = lastSignals.find((s) => s.id === currentSelectedSignalId);
      if (sig) {
        const bi = locate(currentBars, sig.time);
        if (bi >= 0) {
          const endIdx = Math.min(currentBars.length - 1, bi + 15);
          const t1 = currentBars[bi].time as UTCTimestamp;
          const t2 = currentBars[endIdx].time as UTCTimestamp;
          if (sig.stop_loss > 0) {
            signalSlLine.setData([
              { time: t1, value: sig.stop_loss },
              { time: t2, value: sig.stop_loss },
            ]);
          } else {
            signalSlLine.setData([]);
          }
          if (sig.take_profit > 0) {
            signalTpLine.setData([
              { time: t1, value: sig.take_profit },
              { time: t2, value: sig.take_profit },
            ]);
          } else {
            signalTpLine.setData([]);
          }
        }
      } else {
        signalSlLine.setData([]);
        signalTpLine.setData([]);
      }
    } else {
      signalSlLine.setData([]);
      signalTpLine.setData([]);
    }
  }
}
