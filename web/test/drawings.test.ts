import assert from "node:assert/strict";
import test from "node:test";
import { FIB_LEVELS } from "../src/drawings/fibonacci.ts";
import { DrawingManager } from "../src/drawings/manager.ts";
import type { CoordinateConverter, Drawing } from "../src/drawings/types.ts";

class MockCanvas {
  public width = 800;
  public height = 600;
  public style: { pointerEvents?: string; cursor?: string } = {};
  public parentElement = {
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  private listeners: Record<string, ((e: any) => void)[]> = {};

  public getContext(): any {
    return {
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      fillText: () => {},
      save: () => {},
      restore: () => {},
      arc: () => {},
      roundRect: () => {},
      setLineDash: () => {},
      measureText: () => ({ width: 50 }),
      setTransform: () => {},
      scale: () => {},
    };
  }

  public addEventListener(event: string, fn: (e: any) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public trigger(event: string, payload: any): void {
    const list = this.listeners[event] ?? [];
    for (const fn of list) fn(payload);
  }

  public getBoundingClientRect(): any {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

const mockConverter: CoordinateConverter = {
  timeToX: (t) => t - 1_700_000_000,
  xToTime: (x) => 1_700_000_000 + x,
  priceToY: (p) => 1000 - p,
  yToPrice: (y) => 1000 - y,
  snapPoint: (x, y) => null,
};

test("fibonacci levels include standard golden ratios", () => {
  const ratios = FIB_LEVELS.map((l) => l.ratio);
  assert.deepEqual(ratios, [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]);
});

test("drawing manager: tool switching and state", () => {
  const canvas = new MockCanvas() as any;
  const mgr = new DrawingManager(canvas, mockConverter);

  assert.equal(mgr.getActiveTool(), "cursor");
  assert.equal(canvas.style.pointerEvents, "none");

  mgr.setTool("trendline");
  assert.equal(mgr.getActiveTool(), "trendline");
  assert.equal(canvas.style.pointerEvents, "auto");
  assert.equal(canvas.style.cursor, "crosshair");
});

test("drawing manager: add, count, and clear", () => {
  const canvas = new MockCanvas() as any;
  const mgr = new DrawingManager(canvas, mockConverter);
  let countSeen = -1;
  mgr.onChange((c) => {
    countSeen = c;
  });

  assert.equal(countSeen, 0);

  const d: Drawing = {
    id: "t1",
    type: "trendline",
    p1: { time: 1_700_000_000, price: 100 },
    p2: { time: 1_700_000_060, price: 105 },
  };

  mgr.addDrawing(d);
  assert.equal(mgr.getDrawings().length, 1);
  assert.equal(countSeen, 1);

  mgr.clear();
  assert.equal(mgr.getDrawings().length, 0);
  assert.equal(countSeen, 0);
});

test("drawing manager: interactive two-point placement", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  mgr.setTool("box_zone");

  // First click sets pending point
  canvas.trigger("pointerdown", { clientX: 100, clientY: 200 });
  assert.equal(mgr.getDrawings().length, 0);

  // Second click completes drawing and resets tool to cursor
  canvas.trigger("pointerdown", { clientX: 300, clientY: 400 });
  assert.equal(mgr.getDrawings().length, 1);
  assert.equal(mgr.getDrawings()[0].type, "box_zone");
  assert.equal(mgr.getActiveTool(), "cursor");
});

test("drawing manager: horizontal line single-click placement", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  mgr.setTool("horizontal");
  canvas.trigger("pointerdown", { clientX: 250, clientY: 300 });

  assert.equal(mgr.getDrawings().length, 1);
  assert.equal(mgr.getDrawings()[0].type, "horizontal");
  assert.equal(mgr.getActiveTool(), "cursor");
});
