import {
  ColorType, CrosshairMode, LineStyle, LineType, createChart,
  type CandlestickData, type ISeriesApi, type LineData, type UTCTimestamp, type WhitespaceData,
} from "lightweight-charts";
import { DrawingManager } from "./drawings/manager.ts";
import type { CoordinateConverter } from "./drawings/types.ts";
import { precisionFor } from "./format";
import { buildMarkers } from "./overlays/markers";
import { buildSignalMarkers } from "./overlays/signals";
import { barIndexAt, locate } from "./overlays/snap.ts";
import { buildTrail, type TrailPoint } from "./overlays/sl_tp_trail";
import type { Bar, Signal, Trade } from "./types";
import { DrawingFloatingToolbar } from "./ui/drawing_toolbar.ts";


const UP = "#0ecb81", DOWN = "#f6465d";

export interface Ohlc { open: number; high: number; low: number; close: number; }

export type TradeOverlayMode = "focus" | "all" | "off";

export interface TerminalChart {
  setBars(bars: Bar[], fit?: boolean): void;
  fit(): void;
  /** Draw entry/exit markers and SL/TP paths for `trades` against the bars currently shown. */
  setTrades(trades: Trade[], bars: Bar[]): void;
  setTradeOverlayMode(mode: TradeOverlayMode): void;
  setSelectedTrade(tradeId: number | null): void;
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
}



export function createTerminalChart(container: HTMLElement): TerminalChart {
  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "#0b0e11" }, textColor: "#848e9c" },
    grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#262932", autoScale: false },
    timeScale: { borderColor: "#262932", timeVisible: true, secondsVisible: false },
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
    while (pool.length < lanes.length) pool.push(make());
    pool.forEach((series, i) => series.setData(toData(lanes[i] ?? [])));
  };

  const drawingCanvas = document.createElement("canvas");
  drawingCanvas.className = "drawing-canvas";
  container.style.position = "relative";
  container.appendChild(drawingCanvas);

  let currentBars: Bar[] = [];
  let lastTrades: Trade[] = [];
  let lastSignals: Signal[] = [];
  let signalsVisible: boolean = true;
  let currentOverlayMode: TradeOverlayMode = "focus";
  let currentSelectedTradeId: number | null = null;
  let currentSelectedSignalId: string | null = null;
  const conv: CoordinateConverter = {
    timeToX: (t) => chart.timeScale().timeToCoordinate(t as UTCTimestamp),
    xToTime: (x) => chart.timeScale().coordinateToTime(x as any) as number | null,
    priceToY: (p) => candles.priceToCoordinate(p),
    yToPrice: (y) => candles.coordinateToPrice(y as any) as number | null,
    snapPoint: (x, y) => {
      if (currentBars.length === 0) return null;
      const t = chart.timeScale().coordinateToTime(x as any) as number | null;
      if (t === null) return null;
      const bi = barIndexAt(currentBars, t);
      if (bi < 0 || bi >= currentBars.length) return null;
      const b = currentBars[bi];
      const bx = chart.timeScale().timeToCoordinate(b.time as UTCTimestamp);
      if (bx === null || Math.abs(bx - x) > 24) return null;
      const py = candles.coordinateToPrice(y as any);
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
  };

  const drawings = new DrawingManager(drawingCanvas, conv);
  const floatingToolbar = new DrawingFloatingToolbar(container, drawings);

  // Auto scale (fits data to screen) under price column
  const axisCorner = document.createElement("div");
  axisCorner.className = "chart-axis-corner";
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "chart-auto-btn";
  autoBtn.title = "Auto (fits data to screen) [Alt+A]";
  autoBtn.textContent = "auto";
  axisCorner.appendChild(autoBtn);
  container.appendChild(axisCorner);

  let autoScale = false; // default to non-Auto
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


  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    drawings.render();
    floatingToolbar.updatePosition();
    const opts = chart.priceScale("right").options();
    if (opts.autoScale !== undefined && opts.autoScale !== autoScale) {
      autoScale = opts.autoScale;
      updateAutoBtn();
      for (const cb of autoScaleListeners) {
        cb(autoScale);
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

    setBars(bars, fit = false) {
      currentBars = bars;
      if (bars.length > 0) {
        const p = precisionFor(bars[bars.length - 1].close);
        candles.applyOptions({ priceFormat: { type: "price", precision: p, minMove: 1 / 10 ** p } });
      }
      candles.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      volume.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, value: b.volume,
        color: b.close >= b.open ? "rgba(14,203,129,0.4)" : "rgba(246,70,93,0.4)",
      })));

      if (!hasInitializedScale && bars.length > 0) {
        chart.priceScale("right").applyOptions({ autoScale: true });
        if (fit) chart.timeScale().fitContent();
        if (!autoScale) {
          requestAnimationFrame(() => {
            if (!autoScale) {
              chart.priceScale("right").applyOptions({ autoScale: false });
            }
          });
        }
        hasInitializedScale = true;
      } else {
        if (fit) chart.timeScale().fitContent();
      }
      drawings.render();
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
      return;
    }

    let tradeMarkers: ReturnType<typeof buildMarkers> = [];

    if (currentOverlayMode === "off") {
      tradeConnector.setData([]);
      sync(slLanes, [], makeSl);
      sync(tpLanes, [], makeTp);
    } else if (currentOverlayMode === "focus") {
      let focused: Trade[] = [];
      if (currentSelectedTradeId !== null) {
        const found = lastTrades.find((t) => t.id === currentSelectedTradeId);
        if (found) focused = [found];
      }
      if (focused.length === 0) {
        focused = lastTrades.filter((t) => t.exit_time === null);
      }

      tradeMarkers = buildMarkers(focused, currentBars, false, currentSelectedTradeId);
      const trail = buildTrail(focused, currentBars);
      sync(slLanes, trail.sl, makeSl);
      sync(tpLanes, trail.tp, makeTp);

      if (focused.length === 1 && focused[0].exit_time !== null) {
        const ft = focused[0];
        const exitTime = ft.exit_time;
        if (exitTime !== null) {
          const ei = locate(currentBars, ft.entry_time);
          const xi = locate(currentBars, exitTime);
          if (ei >= 0 && xi >= 0) {
            tradeConnector.applyOptions({
              color: ft.pnl >= 0 ? "rgba(14, 203, 129, 0.7)" : "rgba(246, 70, 93, 0.7)",
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
      const trail = buildTrail(lastTrades, currentBars);
      sync(slLanes, trail.sl, makeSl);
      sync(tpLanes, trail.tp, makeTp);
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
