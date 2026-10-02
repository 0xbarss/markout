import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, VerticalDrawing } from "./types.ts";

export function drawVertical(
  ctx: CanvasRenderingContext2D,
  d: VerticalDrawing,
  conv: CoordinateConverter,
  height: number,
): void {
  const x = conv.timeToX(d.time);
  if (x === null) return;

  const color = d.color ?? "#f7a600";
  const lineWidth = d.lineWidth ?? 1.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  applyLineDash(ctx, d.lineStyle ?? "dashed");

  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  if (d.showTime !== false) {
    // Label tag at bottom
    const dateStr = new Date(d.time * 1000).toISOString().replace("T", " ").substring(0, 16);
    ctx.font = "10px monospace";
    const tw = ctx.measureText(dateStr).width;
    ctx.fillStyle = "rgba(22, 27, 34, 0.85)";
    ctx.fillRect(x - tw / 2 - 4, height - 20, tw + 8, 16);
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.strokeRect(x - tw / 2 - 4, height - 20, tw + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(dateStr, x - tw / 2, height - 8);
  }

  ctx.restore();
}

