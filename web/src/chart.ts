import {
  ColorType, CrosshairMode, LineStyle, LineType, createChart,
  type CandlestickData, type ISeriesApi, type LineData, type UTCTimestamp, type WhitespaceData,
} from "lightweight-charts";
import { precisionFor } from "./format";
import { buildMarkers } from "./overlays/markers";
import { buildTrail, type TrailPoint } from "./overlays/sl_tp_trail";
import type { Bar, Trade } from "./types";

const UP = "#0ecb81", DOWN = "#f6465d";

export interface Ohlc { open: number; high: number; low: number; close: number; }

export interface TerminalChart {
  setBars(bars: Bar[], fit?: boolean): void;
  fit(): void;
  /** Draw entry/exit markers and SL/TP paths for `trades` against the bars currently shown. */
  setTrades(trades: Trade[], bars: Bar[]): void;
  /** Show bar indices [from, to] (relative to the bars passed to setBars). */
  focus(from: number, to: number): void;
  onCrosshair(cb: (ohlc: Ohlc | null) => void): void;
}

export function createTerminalChart(container: HTMLElement): TerminalChart {
  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "#0b0e11" }, textColor: "#848e9c" },
    grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#262932" },
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
  const toData = (pts: TrailPoint[]): (LineData | WhitespaceData)[] =>
    pts.map((p) => p.value === undefined
      ? { time: p.time as UTCTimestamp }
      : { time: p.time as UTCTimestamp, value: p.value });
  const sync = (pool: ISeriesApi<"Line">[], lanes: TrailPoint[][], make: () => ISeriesApi<"Line">) => {
    while (pool.length < lanes.length) pool.push(make());
    pool.forEach((series, i) => series.setData(toData(lanes[i] ?? [])));
  };

  return {
    setBars(bars, fit = false) {
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
      if (fit) chart.timeScale().fitContent();
    },
    fit() {
      chart.timeScale().fitContent();
    },
    setTrades(trades, bars) {
      candles.setMarkers(buildMarkers(trades, bars));
      const trail = buildTrail(trades, bars);
      sync(slLanes, trail.sl, makeSl);
      sync(tpLanes, trail.tp, makeTp);
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
}
