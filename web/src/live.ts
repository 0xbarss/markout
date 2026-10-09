import type { Bar } from "./types.ts";
import { baseInterval, isResamplable, TIMEFRAMES } from "./resample.ts";

export interface LiveStateOptions {
  initialBase?: number;
  initialActive?: number;
  timeframes?: readonly { readonly label: string; readonly sec: number }[];
}

export interface LiveBarResult {
  updatedBar: Bar;
  needsReapply: boolean;
}

function findBarIndex(bars: Bar[], time: number): number {
  if (bars.length === 0) return -1;
  const last = bars[bars.length - 1];
  if (last.time === time) return bars.length - 1;
  if (last.time < time) return -1;
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midTime = bars[mid].time;
    if (midTime === time) return mid;
    if (midTime < time) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

function findBarInsertIndex(bars: Bar[], time: number): number {
  if (bars.length === 0) return 0;
  if (time > bars[bars.length - 1].time) return bars.length;
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].time >= time) high = mid - 1;
    else low = mid + 1;
  }
  return low;
}

export class LiveState {
  private base: number;
  private active: number;
  private readonly timeframes: readonly { readonly label: string; readonly sec: number }[];

  constructor(options?: LiveStateOptions) {
    this.base = options?.initialBase ?? 0;
    this.timeframes = options?.timeframes ?? TIMEFRAMES;
    this.active = options?.initialActive ?? (this.base > 0 ? this.pickActive(this.base) : 0);
  }

  getBase(): number {
    return this.base;
  }

  getActive(): number {
    return this.active;
  }

  setActive(sec: number): boolean {
    if (isResamplable(this.base, sec)) {
      this.active = sec;
      return true;
    }
    return false;
  }

  pickActive(baseSec: number): number {
    return this.timeframes.find((t) => isResamplable(baseSec, t.sec))?.sec ?? baseSec;
  }

  /**
   * Process a new incoming live bar.
   * Updates bars array and re-evaluates base interval if previously unknown.
   */
  onBar(bars: Bar[], b: Bar): LiveBarResult {
    let needsReapply = false;

    if (bars.length === 0) {
      bars.push(b);
      if (this.base > 0) {
        if (this.active === 0 || !isResamplable(this.base, this.active)) {
          this.active = this.pickActive(this.base);
        }
        needsReapply = true;
      }
    } else {
      const last = bars[bars.length - 1];
      if (last.time === b.time) {
        bars[bars.length - 1] = b;
      } else if (b.time > last.time) {
        bars.push(b);
      } else {
        const existingIdx = findBarIndex(bars, b.time);
        if (existingIdx >= 0) {
          bars[existingIdx] = b;
        } else {
          const insertIdx = findBarInsertIndex(bars, b.time);
          bars.splice(insertIdx, 0, b);
          console.warn(`Inserted out-of-order bar at time ${b.time}`);
        }
      }

      if (this.base === 0 && bars.length >= 2) {
        const detected = baseInterval(bars);
        if (detected > 0) {
          this.base = detected;
          this.active = this.pickActive(this.base);
          needsReapply = true;
        }
      }
    }

    let updatedBar: Bar;
    if (this.active === this.base || this.base === 0) {
      updatedBar = b;
    } else {
      const bucketTime = Math.floor(b.time / this.active) * this.active;
      const bucketEnd = bucketTime + this.active;
      let open = 0;
      let high = -Infinity;
      let low = Infinity;
      let close = 0;
      let volume = 0;
      let count = 0;

      for (let i = bars.length - 1; i >= 0; i--) {
        const item = bars[i];
        if (item.time < bucketTime) {
          break;
        }
        if (item.time < bucketEnd) {
          if (count === 0) {
            close = item.close;
          }
          open = item.open;
          if (item.high > high) high = item.high;
          if (item.low < low) low = item.low;
          volume += item.volume ?? 0;
          count++;
        }
      }

      if (count > 0) {
        updatedBar = {
          time: bucketTime,
          open,
          high,
          low,
          close,
          volume,
        };
      } else {
        updatedBar = b;
      }
    }

    return { updatedBar, needsReapply };
  }
}
