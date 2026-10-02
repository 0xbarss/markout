import { drawBoxZone } from "./box_zone.ts";
import { drawFibonacci } from "./fibonacci.ts";
import { drawHorizontal } from "./horizontal.ts";
import { drawMeasure } from "./measure.ts";
import { drawPosition } from "./position.ts";
import { drawTrendline } from "./trendline.ts";
import type {
  CoordinateConverter,
  Drawing,
  DrawingTool,
  Point,
} from "./types.ts";

export class DrawingManager {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private conv: CoordinateConverter;
  private symbol = "—";
  private timeframe = 0;
  private drawings: Drawing[] = [];
  private activeTool: DrawingTool = "cursor";
  private pendingPoint: Point | null = null;
  private previewPoint: Point | null = null;
  private toolListeners = new Set<(tool: DrawingTool) => void>();
  private changeListeners = new Set<(count: number) => void>();

  constructor(canvas: HTMLCanvasElement, conv: CoordinateConverter) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context for drawings");
    this.ctx = ctx;
    this.conv = conv;

    this.bindEvents();
    this.setTool("cursor");
  }

  public setContext(symbol: string, timeframe: number): void {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.loadFromStorage();
    this.render();
  }

  public getActiveTool(): DrawingTool {
    return this.activeTool;
  }

  public setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    this.pendingPoint = null;
    this.previewPoint = null;
    this.canvas.style.pointerEvents = tool === "cursor" ? "none" : "auto";
    this.canvas.style.cursor = tool === "cursor" ? "default" : "crosshair";
    this.emitTool();
    this.render();
  }

  public getDrawings(): readonly Drawing[] {
    return this.drawings;
  }

  public addDrawing(drawing: Drawing): void {
    this.drawings.push(drawing);
    this.saveToStorage();
    this.emitChange();
    this.render();
  }

  public clear(): void {
    this.drawings = [];
    this.pendingPoint = null;
    this.previewPoint = null;
    this.saveToStorage();
    this.emitChange();
    this.render();
  }

  public onToolChange(cb: (tool: DrawingTool) => void): () => void {
    this.toolListeners.add(cb);
    cb(this.activeTool);
    return () => this.toolListeners.delete(cb);
  }

  public onChange(cb: (count: number) => void): () => void {
    this.changeListeners.add(cb);
    cb(this.drawings.length);
    return () => this.changeListeners.delete(cb);
  }

  public resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  public render(): void {
    const width = this.canvas.parentElement?.clientWidth ?? this.canvas.width;
    const height = this.canvas.parentElement?.clientHeight ?? this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);

    for (const d of this.drawings) {
      this.drawSingle(d, width);
    }

    if (this.pendingPoint && this.previewPoint) {
      const preview = this.createPreviewDrawing(this.pendingPoint, this.previewPoint);
      if (preview) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.7;
        this.drawSingle(preview, width);
        this.ctx.restore();
      }
    }
  }

  private drawSingle(d: Drawing, width: number): void {
    switch (d.type) {
      case "trendline":
        drawTrendline(this.ctx, d, this.conv, width);
        break;
      case "horizontal":
        drawHorizontal(this.ctx, d, this.conv, width);
        break;
      case "box_zone":
        drawBoxZone(this.ctx, d, this.conv);
        break;
      case "fibonacci":
        drawFibonacci(this.ctx, d, this.conv, width);
        break;
      case "position":
        drawPosition(this.ctx, d, this.conv);
        break;
      case "measure":
        drawMeasure(this.ctx, d, this.conv);
        break;
    }
  }

  private createPreviewDrawing(p1: Point, p2: Point): Drawing | null {
    switch (this.activeTool) {
      case "trendline":
        return { id: "preview", type: "trendline", p1, p2, ray: false };
      case "box_zone":
        return { id: "preview", type: "box_zone", p1, p2 };
      case "fibonacci":
        return { id: "preview", type: "fibonacci", p1, p2 };
      case "position": {
        const isLong = p2.price >= p1.price;
        const delta = Math.abs(p2.price - p1.price);
        const stopPrice = isLong ? p1.price - delta * 0.5 : p1.price + delta * 0.5;
        return {
          id: "preview",
          type: "position",
          side: isLong ? "long" : "short",
          entry: p1,
          targetPrice: p2.price,
          stopPrice,
          endTime: p2.time,
        };
      }
      case "measure":
        return { id: "preview", type: "measure", p1, p2 };
      default:
        return null;
    }
  }

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.activeTool === "cursor") return;
      const pt = this.eventToPoint(e);
      if (!pt) return;

      if (this.activeTool === "horizontal") {
        this.addDrawing({
          id: `h_${Date.now()}`,
          type: "horizontal",
          price: pt.price,
          time: pt.time,
        });
        this.setTool("cursor");
        return;
      }

      if (!this.pendingPoint) {
        this.pendingPoint = pt;
      } else {
        const p1 = this.pendingPoint;
        const p2 = pt;
        const d = this.createPreviewDrawing(p1, p2);
        if (d) {
          d.id = `d_${Date.now()}`;
          this.addDrawing(d);
        }
        this.setTool("cursor");
      }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (this.activeTool === "cursor" || !this.pendingPoint) return;
      this.previewPoint = this.eventToPoint(e);
      this.render();
    });
  }

  private eventToPoint(e: PointerEvent): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.conv.snapPoint) {
      const snapped = this.conv.snapPoint(x, y);
      if (snapped) return snapped;
    }

    const time = this.conv.xToTime(x);
    const price = this.conv.yToPrice(y);
    if (time === null || price === null) return null;
    return { time, price };
  }

  private storageKey(): string {
    return `markout:drawings:${this.symbol}:${this.timeframe}`;
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.storageKey(), JSON.stringify(this.drawings));
      }
    } catch {
      // Storage unavailable or quota exceeded
    }
  }

  private loadFromStorage(): void {
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(this.storageKey());
        if (raw) {
          this.drawings = JSON.parse(raw);
          this.emitChange();
          return;
        }
      }
    } catch {
      // Malformed json or storage error
    }
    this.drawings = [];
    this.emitChange();
  }

  private emitTool(): void {
    for (const listener of this.toolListeners) {
      listener(this.activeTool);
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      listener(this.drawings.length);
    }
  }
}
