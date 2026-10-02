import type { LineStyleType } from "./types.ts";

export function applyLineDash(ctx: CanvasRenderingContext2D, style?: LineStyleType): void {
  if (style === "dashed") {
    ctx.setLineDash([6, 6]);
  } else if (style === "dotted") {
    ctx.setLineDash([2, 4]);
  } else {
    ctx.setLineDash([]);
  }
}
