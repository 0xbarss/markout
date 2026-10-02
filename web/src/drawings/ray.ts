import type { CoordinateConverter, RayDrawing } from "./types.ts";

export function drawRay(
  ctx: CanvasRenderingContext2D,
  d: RayDrawing,
  conv: CoordinateConverter,
  width: number,
): void {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);

  if (x1 === null || y1 === null || x2 === null || y2 === null) return;

  ctx.save();
  ctx.strokeStyle = "#f7a600";
  ctx.lineWidth = 1.5;

  let endX = x2;
  let endY = y2;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (Math.abs(dx) > 0.001) {
    const slope = dy / dx;
    endX = width;
    endY = y1 + slope * (width - x1);
  }

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  // Highlight points
  ctx.fillStyle = "#f7a600";
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
