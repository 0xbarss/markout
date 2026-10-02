import { applyLineDash } from "./style_utils.ts";
import type { ArrowDrawing, CoordinateConverter } from "./types.ts";

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  d: ArrowDrawing,
  conv: CoordinateConverter,
): void {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);

  if (x1 === null || y1 === null || x2 === null || y2 === null) return;

  const color = d.color ?? "#f7a600";
  const lineWidth = d.lineWidth ?? 2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  applyLineDash(ctx, d.lineStyle);

  // Main shaft
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Arrowhead
  ctx.setLineDash([]);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(10, lineWidth * 5);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

