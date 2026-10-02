import { fmtPrice } from "../format.ts";
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

  const left = Math.min(x1, x2);
  const right = Math.max(x2, canvasWidth);
  const diff = d.p2.price - d.p1.price;

  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

  for (const lvl of FIB_LEVELS) {
    const price = d.p1.price + diff * lvl.ratio;
    const y = conv.priceToY(price);
    if (y === null) continue;

    ctx.strokeStyle = lvl.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = lvl.color;
    ctx.fillText(`${lvl.ratio.toFixed(3)} (${fmtPrice(price)})`, left + 4, y - 3);
  }

  ctx.restore();
}
