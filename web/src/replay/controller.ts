import type { Bar, Trade } from "../types.ts";
import { clipTradesForReplay } from "./ghost.ts";

export const SUPPORTED_SPEEDS = [1, 2, 5, 10, 20, 50, 100] as const;
export type ReplaySpeed = (typeof SUPPORTED_SPEEDS)[number];

export interface ReplayFrame {
  cursor: number;
  total: number;
  visibleBars: Bar[];
  visibleTrades: Trade[];
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

export class ReplayController {
  private bars: Bar[] = [];
  private trades: Trade[] = [];
  private cursor = 0;
  private isPlaying = false;
  private speed: ReplaySpeed = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameListeners = new Set<FrameListener>();
  private stateListeners = new Set<StateListener>();

  constructor(bars: Bar[] = [], trades: Trade[] = []) {
    this.setData(bars, trades);
  }

  public setData(bars: Bar[], trades: Trade[]): void {
    this.bars = bars;
    this.trades = trades;
    this.cursor = Math.max(0, bars.length - 1);
    this.emitState();
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
    return this.bars.length === 0 || this.cursor >= this.bars.length - 1;
  }

  public getVisibleBars(): Bar[] {
    if (this.bars.length === 0) return [];
    return this.bars.slice(0, this.cursor + 1);
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
    const stepCount = Math.max(1, Math.round(20 / rawInterval));

    this.timer = setInterval(() => {
      let advanced = false;
      for (let s = 0; s < stepCount; s++) {
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
