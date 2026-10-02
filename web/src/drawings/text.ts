import type { CoordinateConverter, TextDrawing } from "./types.ts";

export function drawText(
  ctx: CanvasRenderingContext2D,
  d: TextDrawing,
  conv: CoordinateConverter,
): void {
  const x = conv.timeToX(d.p1.time);
  const y = conv.priceToY(d.p1.price);

  if (x === null || y === null) return;

  ctx.save();
  ctx.font = "12px sans-serif";
  const metrics = ctx.measureText(d.text);
  const padX = 8;
  const w = metrics.width + padX * 2;
  const h = 22;

  ctx.fillStyle = "rgba(22, 27, 34, 0.9)";
  ctx.strokeStyle = "#f7a600";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y - h / 2, w, h, 4) : ctx.rect(x, y - h / 2, w, h);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#eaecef";
  ctx.fillText(d.text, x + padX, y + 4);

  ctx.restore();
}
