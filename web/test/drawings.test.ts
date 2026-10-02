import assert from "node:assert/strict";
import test from "node:test";
import { drawFibonacci, FIB_LEVELS } from "../src/drawings/fibonacci.ts";
import { DrawingManager } from "../src/drawings/manager.ts";
import type { CoordinateConverter, Drawing, FibonacciDrawing } from "../src/drawings/types.ts";

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

test("drawing manager: updateDrawing modifies styles and coordinates", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "tl_1",
    type: "trendline",
    p1: { time: 1_700_000_000, price: 100 },
    p2: { time: 1_700_000_060, price: 110 },
  };
  mgr.addDrawing(d);

  const updated: Drawing = {
    ...d,
    color: "#0ecb81",
    lineWidth: 3,
    lineStyle: "dashed",
    p1: { time: 1_700_000_010, price: 102 },
  };

  mgr.updateDrawing(updated);

  const result = mgr.getDrawings()[0] as any;
  assert.equal(result.color, "#0ecb81");
  assert.equal(result.lineWidth, 3);
  assert.equal(result.lineStyle, "dashed");
  assert.equal(result.p1.price, 102);
});

test("drawing manager: duplicateDrawing clones with offset", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "box_1",
    type: "box_zone",
    p1: { time: 1_700_000_000, price: 100 },
    p2: { time: 1_700_000_060, price: 120 },
    color: "#29b6f6",
    label: "Order Block",
  };
  mgr.addDrawing(d);

  const clone = mgr.duplicateDrawing("box_1");
  assert.ok(clone);
  assert.equal(mgr.getDrawings().length, 2);
  assert.notEqual(clone.id, "box_1");
  assert.equal(clone.type, "box_zone");
  assert.equal((clone as any).label, "Order Block");
  assert.equal((clone as any).color, "#29b6f6");
  // Coordinates are offset
  assert.ok((clone as any).p1.time > 1_700_000_000);
});

test("drawing manager: text tool uses custom textPromptHandler without window.prompt", async () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  let handlerCalled = false;
  mgr.setTextPromptHandler(async (initial) => {
    handlerCalled = true;
    assert.equal(initial, "Note");
    return "Custom Trade Note";
  });

  mgr.setTool("text");
  canvas.trigger("pointerdown", { clientX: 200, clientY: 250 });

  // Yield to promise resolution
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(handlerCalled, true);
  assert.equal(mgr.getDrawings().length, 1);
  const textDrawing = mgr.getDrawings()[0];
  assert.equal(textDrawing.type, "text");
  assert.equal((textDrawing as any).text, "Custom Trade Note");
});

test("drawing manager: getDrawingPixelBounds returns bounding box for floating toolbar", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "tl_2",
    type: "trendline",
    p1: { time: 1_700_000_100, price: 500 },
    p2: { time: 1_700_000_200, price: 600 },
  };
  mgr.addDrawing(d);

  const bounds = mgr.getDrawingPixelBounds(d);
  assert.ok(bounds);
  assert.equal(bounds.minX, 100);
  assert.equal(bounds.maxX, 200);
  assert.equal(bounds.minY, 400); // 1000 - 600
  assert.equal(bounds.maxY, 500); // 1000 - 500
});

test("drawing manager: onEdit callback triggers on openEdit", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "pos_1",
    type: "position",
    side: "long",
    entry: { time: 1_700_000_000, price: 100 },
    targetPrice: 120,
    stopPrice: 90,
    endTime: 1_700_000_100,
  };
  mgr.addDrawing(d);

  let editedDrawing: Drawing | null = null;
  mgr.onEdit((item) => {
    editedDrawing = item;
  });

  mgr.openEdit(d);
  assert.equal(editedDrawing?.id, "pos_1");
});

test("drawing manager: double-clicking a drawing triggers onEdit", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "h_1",
    type: "horizontal",
    price: 500,
    time: 1_700_000_100,
  };
  mgr.addDrawing(d);

  let editedDrawing: Drawing | null = null;
  mgr.onEdit((item) => {
    editedDrawing = item;
  });

  // Rapid clicks at price 500 (y = 500)
  canvas.trigger("pointerdown", { clientX: 200, clientY: 500 });
  canvas.trigger("pointerdown", { clientX: 200, clientY: 500 });

  assert.ok(editedDrawing);
  assert.equal((editedDrawing as any).id, "h_1");
});

test("drawFibonacci: respects extendLeft and extendRight bounds", () => {
  const lineSegments: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let curX = 0, curY = 0;
  const mockCtx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: (x: number, y: number) => { curX = x; curY = y; },
    lineTo: (x: number, y: number) => { lineSegments.push({ x1: curX, y1: curY, x2: x, y2: y }); },
    stroke: () => {},
    fillText: () => {},
    setLineDash: () => {},
  } as any;

  const dNonExt: FibonacciDrawing = {
    id: "fib1",
    type: "fibonacci",
    p1: { time: 1_700_000_100, price: 100 }, // x = 100
    p2: { time: 1_700_000_200, price: 200 }, // x = 200
    extendLeft: false,
    extendRight: false,
  };

  lineSegments.length = 0;
  drawFibonacci(mockCtx, dNonExt, mockConverter, 800);
  // first line is connection line; remaining 7 are level lines
  const nonExtLevels = lineSegments.slice(1);
  assert.equal(nonExtLevels.length, 7);
  for (const seg of nonExtLevels) {
    assert.equal(seg.x1, 100);
    assert.equal(seg.x2, 200);
  }

  // Extend Right
  const dExtRight: FibonacciDrawing = {
    ...dNonExt,
    extendRight: true,
  };
  lineSegments.length = 0;
  drawFibonacci(mockCtx, dExtRight, mockConverter, 800);
  const extRightLevels = lineSegments.slice(1);
  for (const seg of extRightLevels) {
    assert.equal(seg.x1, 100);
    assert.equal(seg.x2, 800);
  }

  // Extend Left and Right
  const dExtBoth: FibonacciDrawing = {
    ...dNonExt,
    extendLeft: true,
    extendRight: true,
  };
  lineSegments.length = 0;
  drawFibonacci(mockCtx, dExtBoth, mockConverter, 800);
  const extBothLevels = lineSegments.slice(1);
  for (const seg of extBothLevels) {
    assert.equal(seg.x1, 0);
    assert.equal(seg.x2, 800);
  }
});


