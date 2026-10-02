import { applyLineDash } from "./style_utils.ts";
import type { BoxZoneDrawing, CoordinateConverter } from "./types.ts";

export function drawBoxZone(
  ctx: CanvasRenderingContext2D,
  d: BoxZoneDrawing,
  conv: CoordinateConverter
): void {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);

  if (x1 === null || y1 === null || x2 === null || y2 === null) return;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  const strokeColor = d.color ?? "rgba(41, 182, 246, 0.6)";
  const fillColor = d.fillColor ?? "rgba(41, 182, 246, 0.12)";
  const lineWidth = d.lineWidth ?? 1;

  ctx.save();
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;

  ctx.fillRect(left, top, width, height);

  applyLineDash(ctx, d.lineStyle);
  ctx.strokeRect(left, top, width, height);

  const label = d.label ?? "Zone";
  if (label.trim().length > 0) {
    ctx.setLineDash([]);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = strokeColor;
    ctx.fillText(label, left + 4, top + 12);
  }

  ctx.restore();
}

