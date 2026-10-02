import type { CoordinateConverter, TextDrawing } from "./types.ts";

export function drawText(
  ctx: CanvasRenderingContext2D,
  d: TextDrawing,
  conv: CoordinateConverter,
): void {
  const x = conv.timeToX(d.p1.time);
  const y = conv.priceToY(d.p1.price);

  if (x === null || y === null) return;

  const fontSize = d.fontSize ?? 12;
  const textColor = d.color ?? "#eaecef";
  const bgColor = d.backgroundColor ?? "rgba(22, 27, 34, 0.9)";
  const borderColor = d.borderColor ?? "#f7a600";

  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  const metrics = ctx.measureText(d.text);
  const padX = 8;
  const w = metrics.width + padX * 2;
  const h = fontSize + 10;

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y - h / 2, w, h, 4) : ctx.rect(x, y - h / 2, w, h);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textBaseline = "middle";
  ctx.fillText(d.text, x + padX, y);

  ctx.restore();
}

