import { drawArrow } from "./arrow.ts";
import { drawBoxZone } from "./box_zone.ts";
import { drawFibonacci, FIB_LEVELS } from "./fibonacci.ts";
import { drawHorizontal } from "./horizontal.ts";
import { drawMeasure } from "./measure.ts";
import { drawPosition } from "./position.ts";
import { drawRay } from "./ray.ts";
import { drawText } from "./text.ts";
import { drawTrendline } from "./trendline.ts";
import { drawVertical } from "./vertical.ts";
import type {
  CoordinateConverter,
  Drawing,
  DrawingTool,
  Point,
} from "./types.ts";

let nextIdCounter = 1;

export function generateDrawingId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return `${prefix}_${crypto.randomUUID()}`;
    } catch (_) {}
  }
  return `${prefix}_${Date.now()}_${nextIdCounter++}`;
}

const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null && Number.isFinite((p as Point).time) && Number.isFinite((p as Point).price);

export function isValidDrawing(d: unknown): d is Drawing {
  if (!d || typeof d !== "object") return false;
  const item = d as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return false;
  switch (item.type) {
    case "trendline":
    case "ray":
    case "arrow":
    case "fibonacci":
    case "measure":
    case "box_zone":
      return isPoint(item.p1) && isPoint(item.p2);
    case "horizontal":
      return Number.isFinite(item.price);
    case "vertical":
      return Number.isFinite(item.time);
    case "position":
      return (
        isPoint(item.entry) &&
        Number.isFinite(item.targetPrice) &&
        Number.isFinite(item.stopPrice) &&
        Number.isFinite(item.endTime)
      );
    case "text":
      return isPoint(item.p1) && typeof item.text === "string";
    default:
      return false;
  }
}

export function parseStoredDrawings(raw: string): Drawing[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(isValidDrawing);
    }
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.drawings)) {
        return obj.drawings.filter(isValidDrawing);
      }
    }
  } catch (_) {}
  return [];
}

export class DrawingManager {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private conv: CoordinateConverter;
  private symbol = "—";
  private drawings: Drawing[] = [];
  private activeTool: DrawingTool = "cursor";
  private pendingPoint: Point | null = null;
  private previewPoint: Point | null = null;
  private selectedId: string | null = null;
  private undoStack: Drawing[][] = [];
  private pendingUndo: Drawing[] | null = null;
  private draggingHandle: { drawingId: string; handleIdx: number } | null = null;
  private draggingDrawing: { drawingId: string; startX: number; startY: number; startPt: Point } | null = null;

  private toolListeners = new Set<(tool: DrawingTool) => void>();
  private changeListeners = new Set<(count: number) => void>();
  private selectListeners = new Set<(selected: Drawing | null) => void>();
  private editListeners = new Set<(selected: Drawing) => void>();
  private textPromptHandler: ((initialText: string) => Promise<string | null>) | null = null;
  private copiedDrawingId: string | null = null;
  private magnetEnabled: boolean = false;
  private magnetListeners = new Set<(enabled: boolean) => void>();
  private activeMeasure: Drawing | null = null;
  private lastSnappedPoint: Point | null = null;

  constructor(canvas: HTMLCanvasElement, conv: CoordinateConverter) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context for drawings");
    this.ctx = ctx;
    this.conv = conv;

    try {
      if (typeof localStorage !== "undefined") {
        this.magnetEnabled = localStorage.getItem("markout:magnet") === "true";
      }
    } catch (_) {}

    this.bindEvents();
    this.bindKeyboard();
    this.setTool("cursor");
  }

  public isMagnet(): boolean {
    return this.magnetEnabled;
  }

  public setMagnet(enabled: boolean): void {
    if (this.magnetEnabled === enabled) return;
    this.magnetEnabled = enabled;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("markout:magnet", String(enabled));
      }
    } catch (_) {}
    for (const cb of this.magnetListeners) {
      cb(this.magnetEnabled);
    }
    this.render();
  }

  public toggleMagnet(): boolean {
    this.setMagnet(!this.magnetEnabled);
    return this.magnetEnabled;
  }

  public onMagnetChange(cb: (enabled: boolean) => void): () => void {
    this.magnetListeners.add(cb);
    cb(this.magnetEnabled);
    return () => this.magnetListeners.delete(cb);
  }

  public setContext(symbol: string, _timeframe?: number): void {
    this.symbol = symbol;
    this.loadFromStorage();
    this.selectedId = null;
    this.render();
  }

  public getActiveTool(): DrawingTool {
    return this.activeTool;
  }

  public setTool(tool: DrawingTool): void {
    if (tool !== "measure") {
      this.activeMeasure = null;
    }
    this.activeTool = tool;
    this.pendingPoint = null;
    this.previewPoint = null;
    this.canvas.style.pointerEvents = tool === "cursor" ? "none" : "auto";
    this.canvas.style.cursor = tool === "cursor" ? "default" : "crosshair";
    if (tool !== "cursor") {
      this.selectDrawing(null);
    }
    this.emitTool();
    this.render();
  }

  public getDrawings(): readonly Drawing[] {
    return this.drawings;
  }

  public getSelectedDrawing(): Drawing | null {
    if (!this.selectedId) return null;
    return this.drawings.find((d) => d.id === this.selectedId) ?? null;
  }

  public selectDrawing(id: string | null): void {
    this.selectedId = id;
    if (this.activeTool === "cursor") {
      this.canvas.style.pointerEvents = id !== null ? "auto" : "none";
      this.canvas.style.cursor = id !== null ? "default" : "default";
    }
    const selected = this.getSelectedDrawing();
    for (const listener of this.selectListeners) {
      listener(selected);
    }
    this.render();
  }


  public onSelect(cb: (selected: Drawing | null) => void): () => void {
    this.selectListeners.add(cb);
    cb(this.getSelectedDrawing());
    return () => this.selectListeners.delete(cb);
  }

  public addDrawing(drawing: Drawing): void {
    this.pushUndo();
    this.drawings.push(drawing);
    this.saveToStorage();
    this.emitChange();
    this.selectDrawing(drawing.id);
  }

  public onEdit(cb: (selected: Drawing) => void): () => void {
    this.editListeners.add(cb);
    return () => this.editListeners.delete(cb);
  }

  public openEdit(drawing: Drawing): void {
    for (const listener of this.editListeners) {
      listener(drawing);
    }
  }

  public setTextPromptHandler(handler: (initialText: string) => Promise<string | null>): void {
    this.textPromptHandler = handler;
  }

  public updateDrawing(drawing: Drawing, recordUndo = true): void {
    const idx = this.drawings.findIndex((d) => d.id === drawing.id);
    if (idx === -1) return;
    if (recordUndo) {
      this.pushUndo();
    }
    this.drawings[idx] = JSON.parse(JSON.stringify(drawing));
    this.saveToStorage();
    this.emitChange();
    if (this.selectedId === drawing.id) {
      const selected = this.getSelectedDrawing();
      for (const listener of this.selectListeners) {
        listener(selected);
      }
    }
    this.render();
  }

  public duplicateDrawing(id: string): Drawing | null {
    const orig = this.drawings.find((d) => d.id === id);
    if (!orig) return null;

    const clone: Drawing = JSON.parse(JSON.stringify(orig));
    clone.id = generateDrawingId("d");

    // Calculate a clear visual offset in pixel space (30px right, 20px down)
    let dt = 3600;
    let dp = 0;

    let refPt: Point | null = null;
    if ("p1" in orig) {
      refPt = orig.p1;
    } else if (orig.type === "position") {
      refPt = orig.entry;
    } else if (orig.type === "horizontal") {
      refPt = { time: orig.time ?? Math.floor(Date.now() / 1000), price: orig.price };
    } else if (orig.type === "vertical") {
      refPt = { time: orig.time, price: 0 };
    }

    if (refPt) {
      const x = this.conv.timeToX(refPt.time);
      const y = this.conv.priceToY(refPt.price);
      if (x !== null && y !== null) {
        const nextX = this.conv.xToTime(x + 30);
        const nextY = this.conv.yToPrice(y + 20);
        if (nextX !== null) dt = nextX - refPt.time;
        if (nextY !== null) dp = nextY - refPt.price;
      }
    }

    if (dp === 0) {
      const p = (orig as any).p1?.price ?? (orig as any).price ?? (orig as any).entry?.price ?? 100;
      dp = p * 0.01 || 1;
    }

    switch (clone.type) {
      case "trendline":
      case "ray":
      case "arrow":
      case "fibonacci":
      case "measure":
      case "box_zone":
        clone.p1.time += dt;
        clone.p1.price += dp;
        clone.p2.time += dt;
        clone.p2.price += dp;
        break;
      case "horizontal":
        clone.price += dp;
        if (clone.time) clone.time += dt;
        break;
      case "vertical":
        clone.time += dt;
        break;
      case "text":
        clone.p1.time += dt;
        clone.p1.price += dp;
        break;
      case "position":
        clone.entry.time += dt;
        clone.entry.price += dp;
        clone.targetPrice += dp;
        clone.stopPrice += dp;
        clone.endTime += dt;
        break;
    }

    this.addDrawing(clone);
    this.selectDrawing(clone.id);
    return clone;
  }


  public deleteDrawing(id: string): void {
    this.pushUndo();
    this.drawings = this.drawings.filter((d) => d.id !== id);
    if (this.selectedId === id) {
      this.selectedId = null;
      this.selectDrawing(null);
    }
    this.saveToStorage();
    this.emitChange();
    this.render();
  }

  public deleteSelected(): void {
    if (!this.selectedId) return;
    this.deleteDrawing(this.selectedId);
  }

  public getDrawingPixelBounds(d: Drawing): { minX: number; maxX: number; minY: number; maxY: number } | null {
    if (d.type === "horizontal") {
      const y = this.conv.priceToY(d.price);
      if (y === null) return null;
      const width = this.canvas.parentElement?.clientWidth ?? this.canvas.width;
      return { minX: width * 0.35, maxX: width * 0.65, minY: y - 10, maxY: y + 10 };
    }

    if (d.type === "vertical") {
      const x = this.conv.timeToX(d.time);
      if (x === null) return null;
      const height = this.canvas.parentElement?.clientHeight ?? this.canvas.height;
      return { minX: x - 10, maxX: x + 10, minY: height * 0.35, maxY: height * 0.65 };
    }

    const pts = this.getControlPoints(d);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let count = 0;
    for (const p of pts) {
      const x = this.conv.timeToX(p.time);
      const y = this.conv.priceToY(p.price);
      if (x !== null && y !== null) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        count++;
      }
    }

    if (count === 0) return null;
    return { minX, maxX, minY, maxY };
  }


  public undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.drawings = prev;
    this.selectedId = null;
    this.pendingPoint = null;
    this.previewPoint = null;
    this.saveToStorage();
    this.emitChange();
    this.selectDrawing(null);
  }

  public clear(): void {
    this.pushUndo();
    this.drawings = [];
    this.selectedId = null;
    this.pendingPoint = null;
    this.previewPoint = null;
    this.saveToStorage();
    this.emitChange();
    this.selectDrawing(null);
  }

  public save(): boolean {
    this.saveToStorage();
    return true;
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
      try {
        this.drawSingle(d, width, height);
        if (d.id === this.selectedId) {
          this.drawSelectionHandles(d);
        }
      } catch (err) {
        console.warn("Failed to render drawing:", d.id, err);
      }
    }

    if (this.activeMeasure) {
      try {
        this.drawSingle(this.activeMeasure, width, height);
      } catch (err) {
        console.warn("Failed to render active measure:", err);
      }
    }

    if (this.pendingPoint && this.previewPoint) {
      const preview = this.createPreviewDrawing(this.pendingPoint, this.previewPoint);
      if (preview) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.7;
        this.drawSingle(preview, width, height);
        this.ctx.restore();
      }
    }

    // Magnet snap target indicator
    if (this.lastSnappedPoint && (this.activeTool !== "cursor" || this.draggingHandle || this.draggingDrawing)) {
      const sx = this.conv.timeToX(this.lastSnappedPoint.time);
      const sy = this.conv.priceToY(this.lastSnappedPoint.price);
      if (sx !== null && sy !== null) {
        this.ctx.save();
        this.ctx.strokeStyle = "#29b6f6";
        this.ctx.fillStyle = "rgba(41, 182, 246, 0.35)";
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.restore();
      }
    }
  }

  private drawSingle(d: Drawing, width: number, height: number): void {
    switch (d.type) {
      case "trendline":
        drawTrendline(this.ctx, d, this.conv, width);
        break;
      case "ray":
        drawRay(this.ctx, d, this.conv, width);
        break;
      case "horizontal":
        drawHorizontal(this.ctx, d, this.conv, width);
        break;
      case "vertical":
        drawVertical(this.ctx, d, this.conv, height);
        break;
      case "arrow":
        drawArrow(this.ctx, d, this.conv);
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
      case "text":
        drawText(this.ctx, d, this.conv);
        break;
    }
  }

  private drawSelectionHandles(d: Drawing): void {
    const pts = this.getControlPoints(d);
    this.ctx.save();
    for (const p of pts) {
      const x = this.conv.timeToX(p.time);
      const y = this.conv.priceToY(p.price);
      if (x === null || y === null) continue;
      this.ctx.fillStyle = "#ffffff";
      this.ctx.strokeStyle = "#f7a600";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  private getControlPoints(d: Drawing): Point[] {
    switch (d.type) {
      case "trendline":
      case "ray":
      case "arrow":
      case "fibonacci":
      case "measure":
        return [d.p1, d.p2];
      case "box_zone":
        return [d.p1, d.p2, { time: d.p1.time, price: d.p2.price }, { time: d.p2.time, price: d.p1.price }];
      case "horizontal": {
        const centerTime = this.conv.xToTime((this.canvas.parentElement?.clientWidth ?? this.canvas.width) / 2);
        return [{ time: d.time ?? centerTime ?? 0, price: d.price }];
      }
      case "vertical":
        return [{ time: d.time, price: this.conv.yToPrice(50) ?? 0 }];
      case "position":
        return [d.entry, { time: d.endTime, price: d.targetPrice }, { time: d.endTime, price: d.stopPrice }];
      case "text":
        return [d.p1];
      default:
        return [];
    }
  }

  private createPreviewDrawing(p1: Point, p2: Point): Drawing | null {
    switch (this.activeTool) {
      case "trendline":
        return { id: "preview", type: "trendline", p1, p2, ray: false };
      case "ray":
        return { id: "preview", type: "ray", p1, p2 };
      case "arrow":
        return { id: "preview", type: "arrow", p1, p2 };
      case "box_zone":
        return { id: "preview", type: "box_zone", p1, p2 };
      case "fibonacci":
        return { id: "preview", type: "fibonacci", p1, p2, extendRight: false, extendLeft: false };
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

  private bindKeyboard(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", (e) => {
      if (typeof HTMLInputElement !== "undefined" && e.target instanceof HTMLInputElement) return;
      if (typeof HTMLTextAreaElement !== "undefined" && e.target instanceof HTMLTextAreaElement) return;

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId) {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === "Escape") {
        if (this.activeMeasure) {
          this.activeMeasure = null;
          this.render();
        }
        if (this.pendingPoint) {
          this.pendingPoint = null;
          this.previewPoint = null;
          this.render();
        } else if (this.selectedId) {
          this.selectDrawing(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && this.selectedId) {
        e.preventDefault();
        this.duplicateDrawing(this.selectedId);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && this.selectedId) {
        this.copiedDrawingId = this.selectedId;
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && this.copiedDrawingId) {
        e.preventDefault();
        this.duplicateDrawing(this.copiedDrawingId);
      }
    });

  }

  private checkHandleHit(px: number, py: number): { drawingId: string; handleIdx: number } | null {
    if (!this.selectedId) return null;
    const selected = this.getSelectedDrawing();
    if (!selected) return null;
    const handles = this.getControlPoints(selected);
    for (let i = 0; i < handles.length; i++) {
      const hx = this.conv.timeToX(handles[i].time);
      const hy = this.conv.priceToY(handles[i].price);
      if (hx !== null && hy !== null && Math.hypot(px - hx, py - hy) <= 8) {
        return { drawingId: selected.id, handleIdx: i };
      }
    }
    return null;
  }

  private bindEvents(): void {
    const parent = this.canvas.parentElement;
    if (parent && typeof parent.addEventListener === "function") {
      parent.addEventListener("pointermove", (e) => {
        if (this.activeTool !== "cursor") return;
        if (this.draggingHandle || this.draggingDrawing) return;
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const handleHit = this.checkHandleHit(px, py);
        const drawingHit = !handleHit && this.hitTest(px, py) !== null;
        if (handleHit || drawingHit || this.selectedId !== null) {
          this.canvas.style.pointerEvents = "auto";
          this.canvas.style.cursor = handleHit ? "grab" : (drawingHit ? "pointer" : "default");
        } else {
          this.canvas.style.pointerEvents = "none";
          this.canvas.style.cursor = "default";
        }
      });

      parent.addEventListener("pointerdown", (e) => {
        if (e.target instanceof Element && (
          e.target.closest(".drawing-floating-toolbar") ||
          e.target.closest(".modal-backdrop") ||
          e.target.closest(".modal-dialog") ||
          e.target.closest(".chart-axis-corner") ||
          e.target.closest("#selected-trade-card")
        )) {
          return;
        }

        if (this.activeMeasure) {
          this.activeMeasure = null;
          this.render();
        }

        if (e.shiftKey && this.activeTool === "cursor") {
          const pt = this.eventToPoint(e);
          if (pt) {
            this.setTool("measure");
            this.pendingPoint = pt;
            return;
          }
        }

        if (this.activeTool === "cursor") {
          const rect = this.canvas.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;

          const handleHit = this.checkHandleHit(px, py);
          const hit = !handleHit ? this.hitTest(px, py) : null;

          if (handleHit) {
            this.pendingUndo = JSON.parse(JSON.stringify(this.drawings));
            this.draggingHandle = handleHit;
            this.canvas.style.pointerEvents = "auto";
            try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
            return;
          }

          if (hit) {
            this.pendingUndo = JSON.parse(JSON.stringify(this.drawings));
            this.selectDrawing(hit.id);
            this.canvas.style.pointerEvents = "auto";
            const pt = this.eventToPoint(e);
            if (pt) {
              this.draggingDrawing = { drawingId: hit.id, startX: px, startY: py, startPt: pt };
              try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
            }
            return;
          }

          if (e.target !== this.canvas && this.selectedId) {
            this.selectDrawing(null);
          }
        }
      });
    }

    let lastPointerDownTime = 0;
    let lastPointerDownDrawingId: string | null = null;

    this.canvas.addEventListener("pointerdown", (e) => {
      const pt = this.eventToPoint(e);
      if (!pt) return;

      if (this.activeMeasure) {
        this.activeMeasure = null;
        this.render();
      }

      if (e.shiftKey && this.activeTool === "cursor") {
        this.setTool("measure");
        this.pendingPoint = pt;
        return;
      }

      if (this.activeTool === "cursor") {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const hit = this.hitTest(px, py);
        const handleHit = this.checkHandleHit(px, py);

        // Check double click directly
        const now = Date.now();
        if (hit && (hit.id === lastPointerDownDrawingId || hit.id === this.selectedId) && (now - lastPointerDownTime) < 400) {
          lastPointerDownTime = 0;
          lastPointerDownDrawingId = null;
          this.selectDrawing(hit.id);
          this.openEdit(hit);
          return;
        }
        lastPointerDownTime = now;
        lastPointerDownDrawingId = hit ? hit.id : null;

        // Check if clicked on a selected drawing's control handle
        if (handleHit) {
          e.stopPropagation?.();
          this.pendingUndo = JSON.parse(JSON.stringify(this.drawings));
          this.draggingHandle = handleHit;
          try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
          return;
        }

        // Check hit testing on drawings
        if (hit) {
          e.stopPropagation?.();
          this.pendingUndo = JSON.parse(JSON.stringify(this.drawings));
          this.selectDrawing(hit.id);
          this.draggingDrawing = { drawingId: hit.id, startX: px, startY: py, startPt: pt };
          try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
        } else {
          this.selectDrawing(null);
        }
        return;
      }


      // Single-click placement tools
      if (this.activeTool === "horizontal") {
        this.addDrawing({
          id: generateDrawingId("h"),
          type: "horizontal",
          price: pt.price,
          time: pt.time,
        });
        this.setTool("cursor");
        return;
      }

      if (this.activeTool === "vertical") {
        this.addDrawing({
          id: generateDrawingId("v"),
          type: "vertical",
          time: pt.time,
        });
        this.setTool("cursor");
        return;
      }

      if (this.activeTool === "text") {
        const onGotText = (text: string | null) => {
          if (text && text.trim().length > 0) {
            this.addDrawing({
              id: generateDrawingId("t"),
              type: "text",
              p1: pt,
              text: text.trim(),
            });
          }
          this.setTool("cursor");
        };

        if (this.textPromptHandler) {
          this.textPromptHandler("Note").then(onGotText);
        } else {
          const text = (typeof window !== "undefined" && typeof window.prompt === "function")
            ? window.prompt("Annotation note:", "Note")
            : "Note";
          onGotText(text);
        }
        return;
      }

      // Two-click placement tools
      if (!this.pendingPoint) {
        this.pendingPoint = pt;
      } else {
        const p1 = this.pendingPoint;
        const p2 = pt;
        if (this.activeTool === "measure") {
          this.activeMeasure = { id: generateDrawingId("m"), type: "measure", p1, p2 };
          this.pendingPoint = null;
          this.previewPoint = null;
          this.setTool("cursor");
          this.render();
          return;
        }
        const d = this.createPreviewDrawing(p1, p2);
        if (d) {
          d.id = generateDrawingId("d");
          this.addDrawing(d);
        }
        this.setTool("cursor");
      }
    });

    this.canvas.addEventListener("dblclick", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit = this.hitTest(px, py);
      if (hit) {
        this.selectDrawing(hit.id);
        this.openEdit(hit);
      } else if (this.selectedId) {
        const selected = this.getSelectedDrawing();
        if (selected) this.openEdit(selected);
      }
    });

    this.canvas.addEventListener("contextmenu", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit = this.hitTest(px, py);
      if (hit) {
        e.preventDefault();
        this.selectDrawing(hit.id);
        this.openEdit(hit);
      }
    });


    this.canvas.addEventListener("pointermove", (e) => {
      const pt = this.eventToPoint(e);
      if (!pt) return;

      if (this.draggingHandle) {
        if (this.pendingUndo) {
          this.pushUndoSnapshot(this.pendingUndo);
          this.pendingUndo = null;
        }
        this.handleDragPoint(this.draggingHandle.drawingId, this.draggingHandle.handleIdx, pt);
        this.render();
        return;
      }

      if (this.draggingDrawing) {
        if (this.pendingUndo) {
          this.pushUndoSnapshot(this.pendingUndo);
          this.pendingUndo = null;
        }
        this.handleMoveDrawing(this.draggingDrawing.drawingId, pt, this.draggingDrawing.startPt);
        this.draggingDrawing.startPt = pt;
        this.render();
        return;
      }

      if (this.activeTool === "cursor") {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const hitHandle = this.checkHandleHit(px, py);
        const hitDrawing = !hitHandle && this.hitTest(px, py) !== null;
        if (hitHandle || hitDrawing || this.selectedId !== null) {
          this.canvas.style.cursor = hitHandle ? "grab" : (hitDrawing ? "pointer" : "default");
        } else {
          this.canvas.style.pointerEvents = "none";
          this.canvas.style.cursor = "default";
        }
        return;
      }

      if (this.pendingPoint) {
        this.previewPoint = pt;
        this.render();
      }
    });

    const finishDrag = (e: PointerEvent) => {
      this.pendingUndo = null;
      if (this.draggingHandle || this.draggingDrawing) {
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        this.saveToStorage();
        this.draggingHandle = null;
        this.draggingDrawing = null;
        if (this.activeTool === "cursor" && !this.selectedId) {
          this.canvas.style.pointerEvents = "none";
        }
      }
    };


    this.canvas.addEventListener("pointerup", finishDrag);
    this.canvas.addEventListener("pointercancel", finishDrag);
  }

  private handleDragPoint(drawingId: string, handleIdx: number, pt: Point): void {
    const d = this.drawings.find((x) => x.id === drawingId);
    if (!d) return;

    switch (d.type) {
      case "trendline":
      case "ray":
      case "arrow":
      case "fibonacci":
      case "measure":
        if (handleIdx === 0) d.p1 = pt;
        else if (handleIdx === 1) d.p2 = pt;
        break;
      case "box_zone":
        if (handleIdx === 0) d.p1 = pt;
        else if (handleIdx === 1) d.p2 = pt;
        else if (handleIdx === 2) { d.p1.time = pt.time; d.p2.price = pt.price; }
        else if (handleIdx === 3) { d.p2.time = pt.time; d.p1.price = pt.price; }
        break;
      case "position":
        if (handleIdx === 0) d.entry = pt;
        else if (handleIdx === 1) { d.endTime = pt.time; d.targetPrice = pt.price; }
        else if (handleIdx === 2) { d.endTime = pt.time; d.stopPrice = pt.price; }
        break;
      case "horizontal":

        d.price = pt.price;
        d.time = pt.time;
        break;
      case "vertical":
        d.time = pt.time;
        break;
      case "text":
        d.p1 = pt;
        break;
    }
  }

  private handleMoveDrawing(drawingId: string, currentPt: Point, prevPt: Point): void {
    const d = this.drawings.find((x) => x.id === drawingId);
    if (!d) return;

    const dt = currentPt.time - prevPt.time;
    const dp = currentPt.price - prevPt.price;

    switch (d.type) {
      case "trendline":
      case "ray":
      case "arrow":
      case "fibonacci":
      case "measure":
      case "box_zone":
        d.p1 = { time: d.p1.time + dt, price: d.p1.price + dp };
        d.p2 = { time: d.p2.time + dt, price: d.p2.price + dp };
        break;
      case "horizontal":
        d.price += dp;
        if (d.time) d.time += dt;
        break;
      case "vertical":
        d.time += dt;
        break;
      case "text":
        d.p1 = { time: d.p1.time + dt, price: d.p1.price + dp };
        break;
      case "position":
        d.entry = { time: d.entry.time + dt, price: d.entry.price + dp };
        d.targetPrice += dp;
        d.stopPrice += dp;
        d.endTime += dt;
        break;
    }
  }

  private hitTest(px: number, py: number): Drawing | null {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (this.isNearDrawing(d, px, py)) {
        return d;
      }
    }
    return null;
  }

  private isNearDrawing(d: Drawing, px: number, py: number): boolean {
    const tol = 10;
    switch (d.type) {
      case "horizontal": {
        const y = this.conv.priceToY(d.price);
        return y !== null && Math.abs(py - y) <= tol;
      }
      case "vertical": {
        const x = this.conv.timeToX(d.time);
        return x !== null && Math.abs(px - x) <= tol;
      }
      case "trendline": {
        const x1 = this.conv.timeToX(d.p1.time);
        const y1 = this.conv.priceToY(d.p1.price);
        const x2 = this.conv.timeToX(d.p2.time);
        const y2 = this.conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return false;
        if (d.extendLeft && (d.extendRight || d.ray)) {
          return this.distToLine(px, py, x1, y1, x2, y2) <= tol;
        }
        if (d.extendRight || d.ray) {
          return this.distToRay(px, py, x1, y1, x2, y2) <= tol;
        }
        if (d.extendLeft) {
          return this.distToRay(px, py, x2, y2, x1, y1) <= tol;
        }
        return this.distToSegment(px, py, x1, y1, x2, y2) <= tol;
      }
      case "ray": {
        const x1 = this.conv.timeToX(d.p1.time);
        const y1 = this.conv.priceToY(d.p1.price);
        const x2 = this.conv.timeToX(d.p2.time);
        const y2 = this.conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return false;
        return this.distToRay(px, py, x1, y1, x2, y2) <= tol;
      }
      case "arrow":
      case "measure": {
        const x1 = this.conv.timeToX(d.p1.time);
        const y1 = this.conv.priceToY(d.p1.price);
        const x2 = this.conv.timeToX(d.p2.time);
        const y2 = this.conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return false;
        return this.distToSegment(px, py, x1, y1, x2, y2) <= tol;
      }
      case "fibonacci": {
        const x1 = this.conv.timeToX(d.p1.time);
        const y1 = this.conv.priceToY(d.p1.price);
        const x2 = this.conv.timeToX(d.p2.time);
        const y2 = this.conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return false;
        if (this.distToSegment(px, py, x1, y1, x2, y2) <= tol) return true;

        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const width = this.canvas.parentElement?.clientWidth ?? this.canvas.width;
        const left = (d.extendLeft || d.extendLines) ? 0 : minX;
        const right = (d.extendRight || d.extendLines) ? width : maxX;

        if (px >= left - tol && px <= right + tol) {
          const diff = d.p2.price - d.p1.price;
          for (const lvl of FIB_LEVELS) {
            const price = d.p1.price + diff * lvl.ratio;
            const y = this.conv.priceToY(price);
            if (y !== null && Math.abs(py - y) <= tol) {
              return true;
            }
          }
        }
        return false;
      }
      case "box_zone": {
        const x1 = this.conv.timeToX(d.p1.time);
        const y1 = this.conv.priceToY(d.p1.price);
        const x2 = this.conv.timeToX(d.p2.time);
        const y2 = this.conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return false;
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        return px >= minX - tol && px <= maxX + tol && py >= minY - tol && py <= maxY + tol;
      }
      case "position": {
        const x1 = this.conv.timeToX(d.entry.time);
        const x2 = this.conv.timeToX(d.endTime);
        const yEntry = this.conv.priceToY(d.entry.price);
        const yTarget = this.conv.priceToY(d.targetPrice);
        const yStop = this.conv.priceToY(d.stopPrice);
        if (x1 === null || x2 === null || yEntry === null || yTarget === null || yStop === null) return false;
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const width = Math.max(20, right - left);
        const minY = Math.min(yEntry, yTarget, yStop);
        const maxY = Math.max(yEntry, yTarget, yStop);
        return px >= left - tol && px <= left + width + tol && py >= minY - tol && py <= maxY + tol;
      }
      case "text": {
        const x = this.conv.timeToX(d.p1.time);
        const y = this.conv.priceToY(d.p1.price);
        if (x === null || y === null) return false;
        const fontSize = d.fontSize ?? 12;
        const h = fontSize + 12;
        const approxW = Math.max(30, (d.text.length * 8) + 16);
        return px >= x - tol && px <= x + approxW + tol && py >= y - h / 2 - tol && py <= y + h / 2 + tol;
      }
      default:
        return false;
    }
  }

  private distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  private distToRay(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, t);
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  private distToLine(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    const t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.drawings)));
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private pushUndoSnapshot(snapshot: Drawing[]): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private eventToPoint(e: PointerEvent): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const isMagnetActive = this.magnetEnabled !== !!e.ctrlKey;
    if (isMagnetActive && this.conv.snapPoint) {
      const snapped = this.conv.snapPoint(x, y);
      if (snapped) {
        this.lastSnappedPoint = snapped;
        return snapped;
      }
    }

    this.lastSnappedPoint = null;
    const time = this.conv.xToTime(x);
    const price = this.conv.yToPrice(y);
    if (time === null || price === null) return null;
    return { time, price };
  }

  private storageKey(): string {
    return `markout:drawings:${this.symbol}`;
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.storageKey(), JSON.stringify({ v: 1, drawings: this.drawings }));
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
          this.drawings = parseStoredDrawings(raw);
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
