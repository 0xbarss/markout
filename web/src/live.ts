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
      const existingIdx = bars.findIndex((x) => x.time === b.time);
      if (existingIdx >= 0) {
        bars[existingIdx] = b;
      } else if (b.time > bars[bars.length - 1].time) {
        bars.push(b);
      } else {
        const insertIdx = bars.findIndex((x) => x.time > b.time);
        if (insertIdx >= 0) {
          bars.splice(insertIdx, 0, b);
        } else {
          bars.push(b);
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
      const bucketBars = bars.filter(
        (item) => item.time >= bucketTime && item.time < bucketTime + this.active,
      );
      if (bucketBars.length > 0) {
        updatedBar = {
          time: bucketTime,
          open: bucketBars[0].open,
          high: Math.max(...bucketBars.map((x) => x.high)),
          low: Math.min(...bucketBars.map((x) => x.low)),
          close: bucketBars[bucketBars.length - 1].close,
          volume: bucketBars.reduce((acc, x) => acc + x.volume, 0),
        };
      } else {
        updatedBar = b;
      }
    }

    return { updatedBar, needsReapply };
  }
}
