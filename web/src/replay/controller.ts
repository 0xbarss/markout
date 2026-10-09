import type { Bar, Signal, Trade } from "../types.ts";
import { clipTradesForReplay } from "./ghost.ts";

export const SUPPORTED_SPEEDS = [1, 2, 5, 10, 20, 50, 100] as const;
export type ReplaySpeed = (typeof SUPPORTED_SPEEDS)[number];

export interface ReplayFrame {
  cursor: number;
  total: number;
  visibleBars: Bar[];
  visibleTrades: Trade[];
  visibleSignals: Signal[];
  isLive: boolean;
}

export interface ReplayState {
  cursor: number;
  total: number;
  isPlaying: boolean;
  speed: ReplaySpeed;
  isLive: boolean;
}

export type FrameListener = (frame: ReplayFrame) => void;
export type StateListener = (state: ReplayState) => void;

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

export class ReplayController {
  private bars: Bar[] = [];
  private trades: Trade[] = [];
  private signals: Signal[] = [];
  private cursor = 0;
  private isPlaying = false;
  private speed: ReplaySpeed = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameListeners = new Set<FrameListener>();
  private stateListeners = new Set<StateListener>();
  private dataVersion = 0;
  private cachedVisibleBars: Bar[] = [];
  private cachedCursor = -1;
  private cachedBarsLength = -1;
  private cachedDataVersion = -1;

  constructor(bars: Bar[] = [], trades: Trade[] = [], signals: Signal[] = []) {
    this.setData(bars, trades, signals);
  }

  public setData(
    bars: Bar[],
    trades: Trade[],
    signals: Signal[] = this.signals,
    preserveTime: number | null = null,
  ): void {
    this.bars = bars;
    this.trades = trades;
    this.signals = signals;
    if (preserveTime === null || bars.length === 0) {
      this.cursor = Math.max(0, bars.length - 1);
    } else {
      let idx = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].time <= preserveTime) {
          idx = i;
          break;
        }
      }
      this.cursor = idx >= 0 ? idx : 0;
    }
    this.dataVersion++;
    this.emitState();
    this.emitFrame();
  }

  public setSignals(signals: Signal[]): void {
    this.signals = signals;
    this.emitFrame();
  }

  public getVisibleSignals(): Signal[] {
    const b = this.bars[this.cursor];
    if (!b) return [];
    return this.signals.filter((s) => s.time <= b.time);
  }

  public appendOrUpdateBar(bar: Bar): void {
    if (this.bars.length === 0) {
      this.bars.push(bar);
      this.cursor = 0;
      this.dataVersion++;
      this.emitState();
      this.emitFrame();
      return;
    }

    const wasLive = !this.isPlaying && (this.cursor >= this.bars.length - 2);
    const lastBar = this.bars[this.bars.length - 1];

    if (bar.time === lastBar.time) {
      this.bars[this.bars.length - 1] = bar;
      if (wasLive) {
        this.cursor = this.bars.length - 1;
      }
      this.dataVersion++;
      this.emitState();
      this.emitFrame();
      return;
    }

    if (bar.time > lastBar.time) {
      this.bars.push(bar);
      if (wasLive) {
        this.cursor = this.bars.length - 1;
      }
      this.dataVersion++;
      this.emitState();
      this.emitFrame();
      return;
    }

    const existingIdx = findBarIndex(this.bars, bar.time);
    if (existingIdx >= 0) {
      this.bars[existingIdx] = bar;
      if (wasLive) {
        this.cursor = this.bars.length - 1;
      }
      this.dataVersion++;
      this.emitState();
      this.emitFrame();
      return;
    }

    const insertIdx = findBarInsertIndex(this.bars, bar.time);
    this.bars.splice(insertIdx, 0, bar);
    console.warn(`Inserted out-of-order bar at time ${bar.time}`);
    if (wasLive) {
      this.cursor = this.bars.length - 1;
    }
    this.dataVersion++;
    this.emitState();
    this.emitFrame();
  }

  public getBars(): Bar[] {
    return this.bars;
  }

  public updateTrades(trades: Trade[]): void {
    this.trades = trades;
    this.emitFrame();
  }

  public updateTrade(trade: Trade): void {
    const idx = this.trades.findIndex((t) => t.id === trade.id);
    if (idx >= 0) {
      this.trades[idx] = trade;
    } else {
      this.trades.push(trade);
    }
    this.emitFrame();
  }

  public updateRiskBracket(
    tradeId: number,
    stopLoss: number | null,
    takeProfit: number | null,
    timestamp: number
  ): void {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade) return;

    if (takeProfit !== null) {
      trade.take_profit = takeProfit;
    }
    if (stopLoss !== null) {
      const history = trade.sl_history;
      const lastPoint = history[history.length - 1];
      if (lastPoint && lastPoint.time === timestamp) {
        lastPoint.price = stopLoss;
      } else {
        history.push({ time: timestamp, price: stopLoss });
      }
    }
    this.emitFrame();
  }


  public getCursor(): number {
    return this.cursor;
  }

  public getTotal(): number {
    return this.bars.length;
  }

  public getSpeed(): ReplaySpeed {
    return this.speed;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public isLive(): boolean {
    return this.bars.length === 0 || this.cursor >= this.bars.length - 2;
  }

  public getVisibleBars(): Bar[] {
    if (this.bars.length === 0) return [];
    if (
      this.cursor === this.cachedCursor &&
      this.bars.length === this.cachedBarsLength &&
      this.dataVersion === this.cachedDataVersion
    ) {
      return this.cachedVisibleBars;
    }
    this.cachedCursor = this.cursor;
    this.cachedBarsLength = this.bars.length;
    this.cachedDataVersion = this.dataVersion;
    this.cachedVisibleBars =
      this.cursor === this.bars.length - 1
        ? this.bars.slice()
        : this.bars.slice(0, this.cursor + 1);
    return this.cachedVisibleBars;
  }

  public getVisibleTrades(): Trade[] {
    return clipTradesForReplay(this.trades, this.getVisibleBars());
  }

  public onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    listener(this.currentFrame());
    return () => this.frameListeners.delete(listener);
  }

  public onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  public play(): void {
    if (this.bars.length === 0) return;
    if (this.cursor >= this.bars.length - 1) {
      this.cursor = 0;
      this.emitFrame();
    }
    this.isPlaying = true;
    this.startLoop();
    this.emitState();
  }

  public pause(): void {
    this.isPlaying = false;
    this.stopLoop();
    this.emitState();
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stepForward(): void {
    if (this.bars.length === 0) return;
    this.pause();
    if (this.cursor < this.bars.length - 1) {
      this.cursor += 1;
      this.emitFrame();
      this.emitState();
    }
  }

  public stepBackward(): void {
    if (this.bars.length === 0) return;
    this.pause();
    if (this.cursor > 0) {
      this.cursor -= 1;
      this.emitFrame();
      this.emitState();
    }
  }

  public seek(index: number): void {
    if (this.bars.length === 0) return;
    const clamped = Math.max(0, Math.min(this.bars.length - 1, Math.round(index)));
    if (clamped !== this.cursor) {
      this.cursor = clamped;
      this.emitFrame();
      this.emitState();
    }
  }

  public jumpToLive(): void {
    if (this.bars.length === 0) return;
    this.seek(this.bars.length - 1);
  }

  public setSpeed(multiplier: number): void {
    if (SUPPORTED_SPEEDS.includes(multiplier as ReplaySpeed)) {
      this.speed = multiplier as ReplaySpeed;
      if (this.isPlaying) {
        this.startLoop();
      }
      this.emitState();
    }
  }

  public cycleSpeed(): ReplaySpeed {
    const idx = SUPPORTED_SPEEDS.indexOf(this.speed);
    const nextIdx = (idx + 1) % SUPPORTED_SPEEDS.length;
    this.setSpeed(SUPPORTED_SPEEDS[nextIdx]);
    return this.speed;
  }

  public destroy(): void {
    this.pause();
    this.frameListeners.clear();
    this.stateListeners.clear();
  }

  private startLoop(): void {
    this.stopLoop();
    const baseIntervalMs = 400;
    const rawInterval = baseIntervalMs / this.speed;
    const intervalMs = Math.max(20, Math.round(rawInterval));
    let lastTime = performance.now();
    let acc = 0;

    this.timer = setInterval(() => {
      const now = performance.now();
      const dtSec = Math.max(0, (now - lastTime) / 1000);
      lastTime = now;
      acc += this.speed * 2.5 * dtSec;
      const steps = Math.floor(acc);
      acc -= steps;

      let advanced = false;
      for (let s = 0; s < steps; s++) {
        if (this.cursor < this.bars.length - 1) {
          this.cursor += 1;
          advanced = true;
        } else {
          this.pause();
          break;
        }
      }
      if (advanced) {
        this.emitFrame();
        this.emitState();
      }
    }, intervalMs);
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private currentFrame(): ReplayFrame {
    return {
      cursor: this.cursor,
      total: this.bars.length,
      visibleBars: this.getVisibleBars(),
      visibleTrades: this.getVisibleTrades(),
      visibleSignals: this.getVisibleSignals(),
      isLive: this.isLive(),
    };
  }

  private currentState(): ReplayState {
    return {
      cursor: this.cursor,
      total: this.bars.length,
      isPlaying: this.isPlaying,
      speed: this.speed,
      isLive: this.isLive(),
    };
  }

  private emitFrame(): void {
    const frame = this.currentFrame();
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }

  private emitState(): void {
    const state = this.currentState();
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}
