import assert from "node:assert/strict";
import test from "node:test";
import { drawFibonacci, FIB_LEVELS } from "../src/drawings/fibonacci.ts";
import { DrawingManager, generateDrawingId, isValidDrawing, parseStoredDrawings } from "../src/drawings/manager.ts";
import { formatDuration } from "../src/drawings/measure.ts";
import { formatRgba, parseColor } from "../src/drawings/style_utils.ts";
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
  snapPoint: (_x, _y) => null,
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
  assert.equal((editedDrawing as unknown as Drawing | null)?.id, "pos_1");
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

test("drawing manager: position drawing can be selected and re-selected after deselecting", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const posDrawing: Drawing = {
    id: "pos_test",
    type: "position",
    side: "long",
    entry: { time: 1_700_000_100, price: 500 }, // x=100, y=500
    targetPrice: 600,                           // y=400
    stopPrice: 400,                             // y=600
    endTime: 1_700_000_200,                     // x=200
  };

  mgr.addDrawing(posDrawing);
  assert.equal(mgr.getSelectedDrawing()?.id, "pos_test");

  // Click somewhere far away to deselect (x=700, y=100)
  canvas.trigger("pointerdown", { clientX: 700, clientY: 100 });
  assert.equal(mgr.getSelectedDrawing(), null, "drawing should be deselected");

  // Click back inside the position bracket (x=150, y=450)
  canvas.trigger("pointerdown", { clientX: 150, clientY: 450 });
  assert.equal(mgr.getSelectedDrawing()?.id, "pos_test", "position drawing should be re-selected");
});

test("drawing manager: ray drawing can be selected beyond defining anchor points", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const ray: Drawing = {
    id: "ray_test",
    type: "ray",
    p1: { time: 1_700_000_100, price: 500 }, // x=100, y=500
    p2: { time: 1_700_000_200, price: 500 }, // x=200, y=500 (horizontal ray to the right)
  };

  mgr.addDrawing(ray);
  // Deselect
  canvas.trigger("pointerdown", { clientX: 700, clientY: 100 });
  assert.equal(mgr.getSelectedDrawing(), null);

  // Click on the extended ray far past p2 (x=500, y=500)
  canvas.trigger("pointerdown", { clientX: 500, clientY: 500 });
  assert.equal(mgr.getSelectedDrawing()?.id, "ray_test", "ray should be selectable beyond p2");
});

test("style_utils: parseColor and formatRgba correctly parse and format hex and opacity", () => {
  // Hex without alpha
  assert.deepEqual(parseColor("#f7a600"), { hex: "#f7a600", alpha: 1 });

  // 8-digit hex (#rrggbbaa)
  const parsed8 = parseColor("#f7a60080");
  assert.equal(parsed8.hex, "#f7a600");
  assert.equal(Math.round(parsed8.alpha * 100), 50);

  // rgba string
  const parsedRgba = parseColor("rgba(14, 203, 129, 0.35)");
  assert.equal(parsedRgba.hex, "#0ecb81");
  assert.equal(parsedRgba.alpha, 0.35);

  // formatRgba with alpha=1 returns hex
  assert.equal(formatRgba("#0ecb81", 1), "#0ecb81");

  // formatRgba with alpha < 1 returns rgba(...)
  assert.equal(formatRgba("#0ecb81", 0.5), "rgba(14, 203, 129, 0.5)");
  assert.equal(formatRgba("#f6465d", 0.15), "rgba(246, 70, 93, 0.15)");
});

test("drawing manager: magnet mode toggles and snaps only when active", () => {
  let snapCalled = false;
  const customConverter: CoordinateConverter = {
    ...mockConverter,
    snapPoint: (_x, _y) => {
      snapCalled = true;
      return { time: 1_700_000_999, price: 999 };
    },
  };
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, customConverter);

  // Default is off
  assert.equal(mgr.isMagnet(), false);

  mgr.setTool("trendline");
  snapCalled = false;
  canvas.trigger("pointerdown", { clientX: 100, clientY: 100, ctrlKey: false });
  assert.equal(snapCalled, false, "snapPoint should not be called when magnet is off");

  // Toggle magnet ON
  mgr.setMagnet(true);
  assert.equal(mgr.isMagnet(), true);

  snapCalled = false;
  canvas.trigger("pointerdown", { clientX: 100, clientY: 100, ctrlKey: false });
  assert.equal(snapCalled, true, "snapPoint should be called when magnet is on");

  // Holding Ctrl inverts magnet mode (off when on)
  snapCalled = false;
  canvas.trigger("pointerdown", { clientX: 100, clientY: 100, ctrlKey: true });
  assert.equal(snapCalled, false, "Ctrl key should invert magnet mode");
});

test("drawing manager: measure tool creates temporary overlay and dismisses on click", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  mgr.setTool("measure");
  assert.equal(mgr.getActiveTool(), "measure");

  // Click point 1 and point 2
  canvas.trigger("pointerdown", { clientX: 100, clientY: 100 });
  canvas.trigger("pointerdown", { clientX: 200, clientY: 200 });

  // Measure completes and returns to cursor mode
  assert.equal(mgr.getActiveTool(), "cursor");
  // Does not pollute permanent drawings list
  assert.equal(mgr.getDrawings().length, 0, "measure tool should not add permanent drawing");

  // Clicking anywhere dismisses active measure
  canvas.trigger("pointerdown", { clientX: 300, clientY: 300 });
  assert.equal(mgr.getDrawings().length, 0);
});

test("measure: formatDuration formats second, minute, hour and day scales accurately", () => {
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(5400), "1h 30m");
  assert.equal(formatDuration(86400), "1d");
  assert.equal(formatDuration(90000), "1d 1h");
});

test("drawing manager: generateDrawingId produces unique IDs", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add(generateDrawingId("d"));
  }
  assert.equal(ids.size, 100);
});

test("drawing manager: storage validation drops corrupted entries and parses versioned envelopes", () => {
  assert.equal(isValidDrawing(null), false);
  assert.equal(isValidDrawing({ id: "x", type: "trendline" }), false);
  assert.equal(isValidDrawing({ id: "x", type: "trendline", p1: { time: 100, price: 10 }, p2: null }), false);

  const validTrendline: Drawing = {
    id: "tl_1",
    type: "trendline",
    p1: { time: 1000, price: 100 },
    p2: { time: 1060, price: 105 },
  };
  assert.equal(isValidDrawing(validTrendline), true);

  const rawArray = JSON.stringify([
    { id: "bad_1", type: "trendline" },
    validTrendline,
  ]);
  const parsedFromArray = parseStoredDrawings(rawArray);
  assert.equal(parsedFromArray.length, 1);
  assert.equal(parsedFromArray[0].id, "tl_1");

  const rawEnvelope = JSON.stringify({
    v: 1,
    drawings: [validTrendline, { id: "bad_2", type: "horizontal" }],
  });
  const parsedFromEnvelope = parseStoredDrawings(rawEnvelope);
  assert.equal(parsedFromEnvelope.length, 1);
  assert.equal(parsedFromEnvelope[0].id, "tl_1");

  assert.deepEqual(parseStoredDrawings("invalid json"), []);
});

test("drawing manager: plain clicks do not consume undo history", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const d: Drawing = {
    id: "tl_undo",
    type: "trendline",
    p1: { time: 1_700_000_000, price: 100 },
    p2: { time: 1_700_000_060, price: 120 },
  };
  mgr.addDrawing(d);
  assert.equal(mgr.getDrawings().length, 1);

  // Click on the drawing multiple times without moving/dragging
  for (let i = 0; i < 5; i++) {
    canvas.trigger("pointerdown", { clientX: 30, clientY: 890 }); // near midpoint
    canvas.trigger("pointerup", {});
  }

  // Exactly one undo should revert the addDrawing
  mgr.undo();
  assert.equal(mgr.getDrawings().length, 0, "plain clicks must not push undo entries");
});

test("drawing manager: dialog edit pattern restores original state on undo", () => {
  const canvas = new MockCanvas();
  const mgr = new DrawingManager(canvas as any, mockConverter);

  const orig: Drawing = {
    id: "tl_dialog",
    type: "trendline",
    p1: { time: 1_700_000_000, price: 100 },
    p2: { time: 1_700_000_060, price: 120 },
    color: "#ffffff",
  };
  mgr.addDrawing(orig);

  const draft = { ...orig, color: "#ff0000" };
  // Live preview update
  mgr.updateDrawing(draft, false);
  assert.equal((mgr.getDrawings()[0] as any).color, "#ff0000");

  // OK clicked: restores original silently, then snapshots pre-edit state while applying draft
  mgr.updateDrawing(orig, false);
  mgr.updateDrawing(draft, true);
  assert.equal((mgr.getDrawings()[0] as any).color, "#ff0000");

  // Pressing undo restores the pre-dialog color (#ffffff)
  mgr.undo();
  assert.equal((mgr.getDrawings()[0] as any).color, "#ffffff");
});




