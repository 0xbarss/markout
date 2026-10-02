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

  ctx.save();
  ctx.strokeStyle = "#f7a600";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);

  if (d.ray && x2 !== x1) {
    const slope = (y2 - y1) / (x2 - x1);
    const targetX = x2 > x1 ? canvasWidth : 0;
    const targetY = y1 + slope * (targetX - x1);
    ctx.lineTo(targetX, targetY);
  } else {
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // Anchor dots
  ctx.fillStyle = "#f7a600";
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x2, y2, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
