import type { Bar } from "../types.ts";

/** Index of the last bar with time <= t, or -1 when t precedes every bar. */
export function barIndexAt(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** Like barIndexAt, but -1 also for times beyond the end of the last bar's interval. */
export function locate(bars: Bar[], t: number): number {
  const i = barIndexAt(bars, t);
  if (i < 0) return -1;
  if (i === bars.length - 1 && i > 0) {
    const step = bars[i].time - bars[i - 1].time;
    if (t >= bars[i].time + step) return -1;
  }
  return i;
}
