import { fmtPrice } from "../format.ts";
import { applyLineDash } from "./style_utils.ts";
import type { CoordinateConverter, FibonacciDrawing } from "./types.ts";

export const FIB_LEVELS = [
  { ratio: 0.0, color: "#787b86" },
  { ratio: 0.236, color: "#f6465d" },
  { ratio: 0.382, color: "#f7a600" },
  { ratio: 0.5, color: "#0ecb81" },
  { ratio: 0.618, color: "#00bcd4" },
  { ratio: 0.786, color: "#ab47bc" },
  { ratio: 1.0, color: "#787b86" },
] as const;

export function drawFibonacci(
  ctx: CanvasRenderingContext2D,
  d: FibonacciDrawing,
  conv: CoordinateConverter,
  canvasWidth: number
): void {
  const x1 = conv.timeToX(d.p1.time);
  const x2 = conv.timeToX(d.p2.time);
  if (x1 === null || x2 === null) return;

  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const isExtLeft = !!(d.extendLeft || d.extendLines);
  const isExtRight = !!(d.extendRight || d.extendLines);

  const left = isExtLeft ? 0 : minX;
  const right = isExtRight ? canvasWidth : maxX;
  const diff = d.p2.price - d.p1.price;
  const lineWidth = d.lineWidth ?? 1;

  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.lineWidth = lineWidth;

  // Trend connection line between anchors
  const y1 = conv.priceToY(d.p1.price);
  const y2 = conv.priceToY(d.p2.price);
  if (y1 !== null && y2 !== null) {
    ctx.strokeStyle = d.color ? d.color : "rgba(120, 123, 134, 0.4)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  for (const lvl of FIB_LEVELS) {
    const price = d.p1.price + diff * lvl.ratio;
    const y = conv.priceToY(price);
    if (y === null) continue;

    const levelColor = d.color ?? lvl.color;
    ctx.strokeStyle = levelColor;
    applyLineDash(ctx, d.lineStyle ?? "dashed");
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = levelColor;
    const labelX = isExtLeft ? 8 : Math.max(8, minX + 4);
    ctx.fillText(`${lvl.ratio.toFixed(3)} (${fmtPrice(price)})`, labelX, y - 3);
  }

  ctx.restore();
}

