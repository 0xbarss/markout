import { fmtPrice } from "../format.ts";
import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, HorizontalDrawing } from "./types.ts";

export function drawHorizontal(
  ctx: CanvasRenderingContext2D,
  d: HorizontalDrawing,
  conv: CoordinateConverter,
  canvasWidth: number
): void {
  const y = conv.priceToY(d.price);
  if (y === null) return;

  const color = d.color ?? "#848e9c";
  const lineWidth = d.lineWidth ?? 1;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  applyLineDash(ctx, d.lineStyle ?? "dashed");

  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvasWidth, y);
  ctx.stroke();

  if (d.showPrice !== false) {
    // Price tag callout
    const tag = fmtPrice(d.price);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const metrics = ctx.measureText(tag);
    const tagW = metrics.width + 8;
    const tagH = 16;
    const tagX = Math.max(0, canvasWidth - tagW - 4);
    const tagY = y - tagH / 2;

    ctx.setLineDash([]);
    ctx.fillStyle = "#1e222d";
    ctx.strokeStyle = color;
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.strokeRect(tagX, tagY, tagW, tagH);

    ctx.fillStyle = color === "#848e9c" ? "#eaecef" : color;
    ctx.fillText(tag, tagX + 4, tagY + 11);
  }

  ctx.restore();
}

