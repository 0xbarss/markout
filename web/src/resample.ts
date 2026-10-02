import type { Bar } from "./types";

export const TIMEFRAMES = [
  { label: "1m", sec: 60 }, { label: "5m", sec: 300 }, { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 }, { label: "4h", sec: 14400 }, { label: "1D", sec: 86400 },
] as const;

/** Median spacing between bars in seconds (0 when it cannot be determined). */
export function baseInterval(bars: Bar[]): number {
  if (bars.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < bars.length; i++) diffs.push(bars[i].time - bars[i - 1].time);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** Aggregate bars into `sec`-second buckets aligned to the Unix epoch (UTC). */
export function resample(bars: Bar[], sec: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return out;
}
