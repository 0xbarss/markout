import type { Bar } from "./types";

export const TIMEFRAMES = [
  { label: "1m", sec: 60 },
  { label: "2m", sec: 120 },
  { label: "3m", sec: 180 },
  { label: "5m", sec: 300 },
  { label: "6m", sec: 360 },
  { label: "10m", sec: 600 },
  { label: "12m", sec: 720 },
  { label: "15m", sec: 900 },
  { label: "20m", sec: 1200 },
  { label: "30m", sec: 1800 },
  { label: "1h", sec: 3600 },
  { label: "2h", sec: 7200 },
  { label: "3h", sec: 10800 },
  { label: "4h", sec: 14400 },
  { label: "6h", sec: 21600 },
  { label: "8h", sec: 28800 },
  { label: "12h", sec: 43200 },
  { label: "1D", sec: 86400 },
  { label: "1W", sec: 604800 },
  { label: "1M", sec: 2592000 },
] as const;



/** Median spacing between bars in seconds (0 when it cannot be determined). */
export function baseInterval(bars: Bar[]): number {
  if (bars.length < 2) return 0;
  const sampleCount = Math.min(bars.length - 1, 1000);
  const startIdx = bars.length - sampleCount;
  const diffs: number[] = [];
  for (let i = startIdx; i < bars.length; i++) {
    const diff = bars[i].time - bars[i - 1].time;
    if (diff > 0) {
      diffs.push(diff);
    }
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** Parse a timeframe string or numeric seconds value into integer seconds. */
export function parseTimeframe(input: string | number): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : null;
  }
  const s = input.trim();
  if (!s) return null;
  const exact = TIMEFRAMES.find((t) => t.label === s);
  if (exact) return exact.sec;
  const lowerMatch = TIMEFRAMES.find((t) => t.label.toLowerCase() === s.toLowerCase());
  if (lowerMatch && s !== "1M") return lowerMatch.sec;
  const num = Number(s);
  if (Number.isFinite(num) && num > 0) return Math.floor(num);
  const m = s.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "M") return val * 2592000;
  switch (unit.toLowerCase()) {
    case "s":
      return val;
    case "m":
      return val * 60;
    case "h":
      return val * 3600;
    case "d":
      return val * 86400;
    case "w":
      return val * 604800;
    default:
      return null;
  }
}

export const WEEK_SEC = 604800;
export const MONTH_SEC = 2592000;
const MONDAY_OFFSET = 259200; // 3 days in seconds (Unix epoch 1970-01-01 was Thursday; Monday was 3 days earlier)

/** Align timestamp to bucket boundary in seconds. */
export function bucketTime(t: number, sec: number): number {
  if (sec === MONTH_SEC) {
    const d = new Date(t * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  if (sec === WEEK_SEC) {
    return Math.floor((t + MONDAY_OFFSET) / WEEK_SEC) * WEEK_SEC - MONDAY_OFFSET;
  }
  return Math.floor(t / sec) * sec;
}

/**
 * Checks if a target timeframe interval (in seconds) can be cleanly aggregated from a base interval.
 * Returns true only if targetSec >= baseSec and targetSec is an integer multiple of baseSec,
 * or for 1M (month) when baseSec <= 1 day or 1 week.
 */
export function isResamplable(baseSec: number, targetSec: number): boolean {
  if (baseSec <= 0 || targetSec <= 0) return false;
  if (targetSec < baseSec) return false;
  if (targetSec === MONTH_SEC) {
    return baseSec <= 86400 || baseSec === WEEK_SEC;
  }
  return targetSec % baseSec === 0;
}

/** Aggregate bars into `sec`-second buckets aligned to calendar/epoch standards. */
export function resample(bars: Bar[], sec: number, baseSec?: number): Bar[] {
  if (baseSec && !isResamplable(baseSec, sec)) {
    return bars;
  }
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketTime(b.time, sec);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      if (b.high > last.high) last.high = b.high;
      if (b.low < last.low) last.low = b.low;
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return out;
}

/**
 * Resamples bars up to a cursor index, ensuring hindsight-free playback
 * where the current in-progress bucket excludes future base bars.
 */
export function resampleHindsightFree(
  baseBars: Bar[],
  cursor: number,
  sec: number,
  baseSec?: number,
): Bar[] {
  if (baseBars.length === 0 || cursor < 0) return [];
  const clamped = Math.min(cursor, baseBars.length - 1);
  return resample(baseBars.slice(0, clamped + 1), sec, baseSec);
}

