import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, TrendlineDrawing } from "./types.ts";

export function drawTrendline(
  ctx: CanvasRenderingContext2D,
  d: TrendlineDrawing,
  conv: CoordinateConverter,
  canvasWidth: number
): void {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);

  if (x1 === null || y1 === null || x2 === null || y2 === null) return;

  const color = d.color ?? "#f7a600";
  const lineWidth = d.lineWidth ?? 1.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  applyLineDash(ctx, d.lineStyle);

  let startX = x1;
  let startY = y1;
  let endX = x2;
  let endY = y2;

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (Math.abs(dx) > 0.0001) {
    const slope = dy / dx;
    if (d.ray || d.extendRight) {
      endX = dx > 0 ? canvasWidth : 0;
      endY = y1 + slope * (endX - x1);
    }
    if (d.extendLeft) {
      startX = dx > 0 ? 0 : canvasWidth;
      startY = y1 + slope * (startX - x1);
    }
  }

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  // Anchor dots
  ctx.fillStyle = color;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x2, y2, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

